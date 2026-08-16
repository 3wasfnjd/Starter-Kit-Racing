import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { buildTrack, computeTrackBounds, computeSpawnPosition } from './Track.js';
import { buildWallColliders, applyArTransform } from './Physics.js';
import { rigidBody, box, MotionType } from 'crashcat';

// ARManager owns everything about *placing* the track in the real room:
// requesting the immersive-ar session, passthrough, horizontal-surface
// hit-testing, the move/rotate/scale preview, and — once confirmed —
// building the real track (via the untouched buildTrack()) and its static
// wall colliders (via the untouched buildWallColliders(), using the new
// optional arTransform parameter) at the chosen spot.
//
// It deliberately knows nothing about the Vehicle class or vehicle physics.
// After placement it only exposes getDriveInput()/isPlaced()/getSpawnWorld()
// so main.js can spawn and drive the existing Vehicle exactly like in
// NORMAL mode.

const DEADZONE = 0.15;
const MOVE_SPEED = 1.5;   // m/s at full stick deflection
const ROTATE_SPEED = 1.2; // rad/s at full stick deflection
const SCALE_SPEED = 0.6;  // scale units/s at full stick deflection
const SCALE_MIN = 0.5;
const SCALE_MAX = 2.0;

export class ARManager {

	constructor( { renderer, scene, models, customCells } ) {

		this.renderer = renderer;
		this.scene = scene;
		this.models = models;
		this.customCells = customCells;

		this.session = null;
		this.hitTestSource = null;
		this.hitTestSourceRequested = false;
		this.referenceSpace = null;

		this.hasHit = false;
		this.placed = false;

		this.arPosition = new THREE.Vector3();
		this.arQuaternion = new THREE.Quaternion();
		this.arScale = 1;

		this.arTrackRoot = new THREE.Group();
		this.arTrackRoot.visible = false;
		this.scene.add( this.arTrackRoot );

		this.world = null; // set by main.js via setWorld() before session start
		this.spawnLocal = computeSpawnPosition( customCells );

		this.previewGroup = this.buildPreviewMesh(); // uses this.spawnLocal — must come after it's set
		this.arTrackRoot.add( this.previewGroup );

		this.gamepads = { left: null, right: null };
		this._prevTrigger = { left: false, right: false };

		this.controllerModelFactory = new XRControllerModelFactory();
		this._setupControllers();

		this._savedBackground = null;
		this._savedFog = null;

		this.onPlaced = null; // callback(spawnWorldPos: Vector3, spawnWorldAngle: number)

		this._camForward = new THREE.Vector3();
		this._camPos = new THREE.Vector3();

	}

	setWorld( world ) {

		this.world = world;

	}

	// ─── UI entry point ───────────────────────────────────

	static async isSupported() {

		if ( ! navigator.xr ) return false;
		try {

			return await navigator.xr.isSessionSupported( 'immersive-ar' );

		} catch ( e ) {

			return false;

		}

	}

	async requestSession() {

		const session = await navigator.xr.requestSession( 'immersive-ar', {
			requiredFeatures: [ 'local-floor', 'hit-test' ],
			// Meta/Quest-specific room awareness. Optional: if unsupported,
			// the session still starts fine and we just skip that part.
			optionalFeatures: [ 'plane-detection', 'mesh-detection' ],
		} );

		this.renderer.xr.setReferenceSpaceType( 'local-floor' );
		await this.renderer.xr.setSession( session );

		this.session = session;
		session.addEventListener( 'end', () => this._onSessionEnd() );

		this._savedBackground = this.scene.background;
		this._savedFog = this.scene.fog;
		this.scene.background = null; // let passthrough show through
		this.scene.fog = null;

		this.arTrackRoot.visible = true;
		this.previewGroup.visible = true;

		console.log( '[ARManager] AR session started. environmentBlendMode:', session.environmentBlendMode );

		return session;

	}

	// ─── Controllers ──────────────────────────────────────

	_setupControllers() {

		for ( let i = 0; i < 2; i ++ ) {

			const controller = this.renderer.xr.getController( i );
			controller.addEventListener( 'connected', ( event ) => {

				const hand = event.data.handedness === 'left' ? 'left' : 'right';
				this.gamepads[ hand ] = event.data.gamepad || null;

			} );
			controller.addEventListener( 'disconnected', ( event ) => {

				const hand = event.data.handedness === 'left' ? 'left' : 'right';
				this.gamepads[ hand ] = null;

			} );
			this.scene.add( controller );

			const grip = this.renderer.xr.getControllerGrip( i );
			this.scene.add( grip );

			// Cosmetic only (renders a controller model in-view). Never
			// let a failure here (e.g. the input-profile asset fetch)
			// break placement or driving.
			try {

				grip.add( this.controllerModelFactory.createControllerModel( grip ) );

			} catch ( e ) {

				console.warn( 'Controller model failed to load (non-fatal):', e );

			}

		}

	}

	// ─── Preview visuals ──────────────────────────────────

	buildPreviewMesh() {

		const group = new THREE.Group();
		const bounds = computeTrackBounds( this.customCells );

		const footprint = new THREE.Mesh(
			new THREE.PlaneGeometry( bounds.halfWidth * 2, bounds.halfDepth * 2 ),
			new THREE.MeshBasicMaterial( { color: 0x15A249, transparent: true, opacity: 0.35, side: THREE.DoubleSide } )
		);
		footprint.rotation.x = - Math.PI / 2;
		footprint.position.set( bounds.centerX, 0.02, bounds.centerZ );
		group.add( footprint );

		const outline = new THREE.LineSegments(
			new THREE.EdgesGeometry( footprint.geometry ),
			new THREE.LineBasicMaterial( { color: 0x15A249 } )
		);
		outline.rotation.copy( footprint.rotation );
		outline.position.copy( footprint.position );
		group.add( outline );

		const arrow = new THREE.Mesh(
			new THREE.ConeGeometry( 0.4, 1.2, 12 ),
			new THREE.MeshBasicMaterial( { color: 0x159897 } )
		);
		arrow.rotation.x = Math.PI / 2;
		arrow.position.set( this.spawnLocal.position[ 0 ], 0.3, this.spawnLocal.position[ 2 ] );
		arrow.rotation.z = this.spawnLocal.angle;
		group.add( arrow );

		group.visible = false;
		return group;

	}

	// ─── Per-frame update (called from the shared animate loop) ──

	update( frame, dt ) {

		if ( ! this.session || ! frame ) return;

		try {

			const refSpace = this.renderer.xr.getReferenceSpace();

			if ( ! this.hitTestSourceRequested ) {

				this.hitTestSourceRequested = true;
				this.session.requestReferenceSpace( 'viewer' ).then( ( viewerSpace ) => {

					this.session.requestHitTestSource( { space: viewerSpace } ).then( ( source ) => {

						this.hitTestSource = source;

					} ).catch( ( e ) => console.warn( '[ARManager] requestHitTestSource failed:', e ) );

				} ).catch( ( e ) => console.warn( '[ARManager] requestReferenceSpace(viewer) failed:', e ) );

			}

			if ( ! this.placed ) {

				this._updatePlacement( frame, refSpace, dt );

			}

		} catch ( e ) {

			console.error( '[ARManager] update() error:', e );

		}

	}

	_updatePlacement( frame, refSpace, dt ) {

		// 1) Surface search: while no manual adjustment has happened yet,
		// keep the preview snapped to the latest hit-test result.
		if ( this.hitTestSource ) {

			const results = frame.getHitTestResults( this.hitTestSource );

			if ( results.length > 0 ) {

				const pose = results[ 0 ].getPose( refSpace );

				if ( ! this.hasHit ) {

					// First surface found: face the track away from the player,
					// and if we can see the room's real floor size, auto-fit
					// the track's starting scale to it (still adjustable after).
					const xrCam = this.renderer.xr.getCamera();
					this._camPos.setFromMatrixPosition( xrCam.matrixWorld );
					this._camForward.set( 0, 0, -1 ).transformDirection( xrCam.matrixWorld );
					const yaw = Math.atan2( this._camForward.x, this._camForward.z );
					this.arQuaternion.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), yaw );

					this._autoFitScaleToRoom( frame );

				}

				this.arPosition.set(
					pose.transform.position.x,
					pose.transform.position.y,
					pose.transform.position.z
				);

				this.hasHit = true;

			}

		}

		// 2) Manual adjustment via thumbsticks (only meaningful once we have
		// an initial hit to adjust from).
		if ( this.hasHit ) {

			this._applyThumbstickAdjustment( Math.min( dt, 1 / 30 ) );

		}

		this.arTrackRoot.position.copy( this.arPosition );
		this.arTrackRoot.quaternion.copy( this.arQuaternion );
		this.arTrackRoot.scale.setScalar( this.arScale );

		this.previewGroup.visible = this.hasHit;

		// 3) Confirm / lock
		if ( this.hasHit && this._triggerPressedEdge() ) {

			this._confirmPlacement( frame, refSpace );

		}

	}

	// Best-effort: use the real detected floor plane's bounding size (Meta
	// plane-detection) to pick a sensible starting scale so the track
	// roughly matches this room, without changing the track's own layout.
	// Silently does nothing if plane-detection isn't available.
	_autoFitScaleToRoom( frame ) {

		try {

			const planes = frame.detectedPlanes;
			if ( ! planes || planes.size === 0 ) return;

			let best = null, bestArea = 0;

			planes.forEach( ( plane ) => {

				if ( plane.orientation && plane.orientation !== 'horizontal' ) return;
				if ( plane.semanticLabel && plane.semanticLabel !== 'floor' ) return;

				const poly = plane.polygon;
				if ( ! poly || poly.length < 3 ) return;

				let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
				poly.forEach( ( p ) => {

					if ( p.x < minX ) minX = p.x;
					if ( p.x > maxX ) maxX = p.x;
					if ( p.z < minZ ) minZ = p.z;
					if ( p.z > maxZ ) maxZ = p.z;

				} );

				const width = maxX - minX, depth = maxZ - minZ, area = width * depth;
				if ( area > bestArea ) {

					bestArea = area;
					best = { width, depth };

				}

			} );

			if ( ! best ) return;

			const bounds = computeTrackBounds( this.customCells );
			const fitScale = Math.min(
				( best.width * 0.85 ) / ( bounds.halfWidth * 2 ),
				( best.depth * 0.85 ) / ( bounds.halfDepth * 2 )
			);

			if ( isFinite( fitScale ) && fitScale > 0 ) {

				this.arScale = THREE.MathUtils.clamp( fitScale, SCALE_MIN, SCALE_MAX );

			}

		} catch ( e ) {

			console.warn( '[ARManager] plane-detection auto-fit unavailable:', e );

		}

	}

	_applyThumbstickAdjustment( dt ) {

		const axesR = this.gamepads.right ? this.gamepads.right.axes : [];
		const axesL = this.gamepads.left ? this.gamepads.left.axes : [];

		const moveX = this._axis( axesR, 2 );
		const moveY = this._axis( axesR, 3 );
		const rotX = this._axis( axesL, 2 );
		const scaleY = this._axis( axesL, 3 );

		if ( moveX !== 0 || moveY !== 0 ) {

			const xrCam = this.renderer.xr.getCamera();
			const forward = this._camForward.set( 0, 0, -1 ).transformDirection( xrCam.matrixWorld );
			forward.y = 0;
			forward.normalize();
			const right = new THREE.Vector3().crossVectors( forward, new THREE.Vector3( 0, 1, 0 ) ).negate();

			this.arPosition
				.addScaledVector( right, moveX * MOVE_SPEED * dt )
				.addScaledVector( forward, - moveY * MOVE_SPEED * dt );

		}

		if ( rotX !== 0 ) {

			const deltaYaw = - rotX * ROTATE_SPEED * dt;
			const deltaQuat = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), deltaYaw );
			this.arQuaternion.premultiply( deltaQuat );

		}

		if ( scaleY !== 0 ) {

			this.arScale = THREE.MathUtils.clamp(
				this.arScale * ( 1 - scaleY * SCALE_SPEED * dt ),
				SCALE_MIN, SCALE_MAX
			);

		}

	}

	_axis( axes, index ) {

		const v = axes && axes.length > index ? axes[ index ] : 0;
		return Math.abs( v ) > DEADZONE ? v : 0;

	}

	_triggerPressedEdge() {

		const rTrig = this.gamepads.right && this.gamepads.right.buttons[ 0 ] ? this.gamepads.right.buttons[ 0 ].pressed : false;
		const lTrig = this.gamepads.left && this.gamepads.left.buttons[ 0 ] ? this.gamepads.left.buttons[ 0 ].pressed : false;

		const rEdge = rTrig && ! this._prevTrigger.right;
		const lEdge = lTrig && ! this._prevTrigger.left;

		this._prevTrigger.right = rTrig;
		this._prevTrigger.left = lTrig;

		return rEdge || lEdge;

	}

	_confirmPlacement( frame, refSpace ) {

		this.placed = true;
		this.previewGroup.visible = false;

		const arTransform = {
			position: this.arPosition.clone(),
			quaternion: this.arQuaternion.clone(),
			scale: this.arScale,
		};
		this.lockedTransform = arTransform;

		buildTrack( this.arTrackRoot, this.models, this.customCells );

		if ( this.world ) {

			buildWallColliders( this.world, null, this.customCells, arTransform );

			const bounds = computeTrackBounds( this.customCells );
			const roadHalf = Math.max( bounds.halfWidth, bounds.halfDepth ) + 10;

			const { position, quaternion } = applyArTransform(
				[ bounds.centerX, - 0.125, bounds.centerZ ],
				[ 0, 0, 0, 1 ],
				arTransform
			);

			rigidBody.create( this.world, {
				shape: box.create( { halfExtents: [ roadHalf * arTransform.scale, 0.01, roadHalf * arTransform.scale ] } ),
				motionType: MotionType.STATIC,
				objectLayer: this.world._OL_STATIC,
				position,
				quaternion,
				friction: 5.0,
				restitution: 0.0,
			} );

			this._buildRoomFurnitureColliders( frame, refSpace );

		}

		if ( this.onPlaced ) this.onPlaced( this.getSpawnWorld() );

	}

	// Best-effort real-world collision: uses Meta's WebXR mesh-detection
	// (requires the room's furniture to already be captured via Space Setup
	// on the headset) to add static, invisible colliders matching real
	// furniture, so the car actually bumps into the real couch/table.
	// Silently skips if the feature/browser/room data isn't available —
	// the game still works fine without it, just without real collision.
	_buildRoomFurnitureColliders( frame, refSpace ) {

		try {

			const meshes = frame.detectedMeshes;
			if ( ! meshes || meshes.size === 0 ) {

				console.log( '[ARManager] No room furniture meshes available (mesh-detection unsupported, or Space Setup furniture capture wasn\'t done on this headset).' );
				return;

			}

			const skipLabels = new Set( [ 'floor', 'ceiling', 'wall-face', 'invisible-wall-face', 'global-mesh', 'wall' ] );
			let count = 0;

			meshes.forEach( ( mesh ) => {

				const label = mesh.semanticLabel || '';
				if ( skipLabels.has( label ) ) return;

				const pose = frame.getPose( mesh.meshSpace, refSpace );
				if ( ! pose ) return;

				const bounds = this._computeVertexBounds( mesh.vertices );
				if ( ! bounds ) return;

				const poseQuat = new THREE.Quaternion(
					pose.transform.orientation.x, pose.transform.orientation.y,
					pose.transform.orientation.z, pose.transform.orientation.w
				);
				const centerLocal = new THREE.Vector3( bounds.cx, bounds.cy, bounds.cz ).applyQuaternion( poseQuat );
				const worldCenter = new THREE.Vector3(
					pose.transform.position.x, pose.transform.position.y, pose.transform.position.z
				).add( centerLocal );

				rigidBody.create( this.world, {
					shape: box.create( { halfExtents: [
						Math.max( bounds.hx, 0.02 ), Math.max( bounds.hy, 0.02 ), Math.max( bounds.hz, 0.02 )
					] } ),
					motionType: MotionType.STATIC,
					objectLayer: this.world._OL_STATIC,
					position: [ worldCenter.x, worldCenter.y, worldCenter.z ],
					quaternion: [ poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w ],
					friction: 0.8,
					restitution: 0.2,
				} );

				count ++;

			} );

			console.log( '[ARManager] Built', count, 'real-world furniture colliders.' );

		} catch ( e ) {

			console.warn( '[ARManager] Room furniture collision unavailable:', e );

		}

	}

	_computeVertexBounds( vertices ) {

		if ( ! vertices || vertices.length < 3 ) return null;

		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

		for ( let i = 0; i < vertices.length; i += 3 ) {

			const x = vertices[ i ], y = vertices[ i + 1 ], z = vertices[ i + 2 ];
			if ( x < minX ) minX = x; if ( x > maxX ) maxX = x;
			if ( y < minY ) minY = y; if ( y > maxY ) maxY = y;
			if ( z < minZ ) minZ = z; if ( z > maxZ ) maxZ = z;

		}

		return {
			hx: ( maxX - minX ) / 2, hy: ( maxY - minY ) / 2, hz: ( maxZ - minZ ) / 2,
			cx: ( maxX + minX ) / 2, cy: ( maxY + minY ) / 2, cz: ( maxZ + minZ ) / 2,
		};

	}

	// ─── Public queries used by main.js after placement ──

	isPlaced() {

		return this.placed;

	}

	getArTrackRoot() {

		return this.arTrackRoot;

	}

	getSpawnWorld() {

		const t = this.lockedTransform;
		const local = this.spawnLocal;

		const worldPos = new THREE.Vector3(
			local.position[ 0 ], local.position[ 1 ], local.position[ 2 ]
		).multiplyScalar( t.scale ).applyQuaternion( t.quaternion ).add( t.position );

		const yaw = new THREE.Euler().setFromQuaternion( t.quaternion, 'YXZ' ).y;

		return { position: worldPos, angle: local.angle + yaw };

	}

	// Driving input, once placed — analogous role to Controls.js, reusing
	// the exact same {x, z} contract Vehicle.update() already expects.
	getDriveInput() {

		const axesR = this.gamepads.right ? this.gamepads.right.axes : [];
		const x = this._axis( axesR, 2 );

		const rTrig = this.gamepads.right && this.gamepads.right.buttons[ 0 ] ? this.gamepads.right.buttons[ 0 ].value : 0;
		const rGrip = this.gamepads.right && this.gamepads.right.buttons[ 1 ] ? this.gamepads.right.buttons[ 1 ].value : 0;
		const lTrig = this.gamepads.left && this.gamepads.left.buttons[ 0 ] ? this.gamepads.left.buttons[ 0 ].value : 0;

		// Right trigger/grip = throttle, left trigger = brake/reverse.
		const z = Math.max( rTrig, rGrip ) - lTrig;

		return { x, z, touchActive: false };

	}

	_onSessionEnd() {

		this.session = null;
		this.hitTestSource = null;
		this.hitTestSourceRequested = false;

		if ( this._savedBackground !== null ) this.scene.background = this._savedBackground;
		this.scene.fog = this._savedFog;

		this.arTrackRoot.visible = false;

	}

}
