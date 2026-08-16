import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { rigidBody, box, MotionType } from 'crashcat';

// ARManager: free-roam AR mode. No TRACK_CELLS, no fixed track — the
// player places a spawn point/heading in their real room, then drives on
// the real (passthrough) floor with real furniture as solid obstacles
// (via Meta's WebXR mesh-detection, best-effort).
//
// It deliberately knows nothing about the Vehicle class or vehicle physics.
// After placement it only exposes getDriveInput()/isPlaced()/getSpawnWorld()
// so main.js can spawn and drive the existing Vehicle exactly like in
// NORMAL mode.

const DEADZONE = 0.15;
const MOVE_SPEED = 1.5;   // m/s at full stick deflection
const ROTATE_SPEED = 1.2; // rad/s at full stick deflection

export class ARManager {

	constructor( { renderer, scene, models } ) {

		this.renderer = renderer;
		this.scene = scene;
		this.models = models;

		this.session = null;
		this.hitTestSource = null;
		this.hitTestSourceRequested = false;

		this.hasHit = false;
		this.placed = false;

		this.arPosition = new THREE.Vector3();
		this.arQuaternion = new THREE.Quaternion();

		this.previewGroup = this.buildPreviewMesh();
		this.previewGroup.visible = false;
		this.scene.add( this.previewGroup );

		this.world = null; // set by main.js via setWorld() before session start

		this.gamepads = { left: null, right: null };
		this._prevTrigger = { left: false, right: false };

		this.controllerModelFactory = new XRControllerModelFactory();
		this._setupControllers();

		this._savedBackground = null;
		this._savedFog = null;

		this.onPlaced = null; // callback({position: Vector3, angle: number})

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
	// Just a spawn-point ring + forward arrow now — there's no track
	// footprint to preview anymore.

	buildPreviewMesh() {

		const group = new THREE.Group();

		const ring = new THREE.Mesh(
			new THREE.RingGeometry( 0.45, 0.55, 32 ),
			new THREE.MeshBasicMaterial( { color: 0x15A249, transparent: true, opacity: 0.8, side: THREE.DoubleSide } )
		);
		ring.rotation.x = - Math.PI / 2;
		ring.position.y = 0.02;
		group.add( ring );

		const fill = new THREE.Mesh(
			new THREE.CircleGeometry( 0.45, 32 ),
			new THREE.MeshBasicMaterial( { color: 0x15A249, transparent: true, opacity: 0.25, side: THREE.DoubleSide } )
		);
		fill.rotation.x = - Math.PI / 2;
		fill.position.y = 0.015;
		group.add( fill );

		const arrow = new THREE.Mesh(
			new THREE.ConeGeometry( 0.14, 0.5, 12 ),
			new THREE.MeshBasicMaterial( { color: 0x159897 } )
		);
		arrow.rotation.x = Math.PI / 2;
		arrow.position.set( 0, 0.05, -0.55 );
		group.add( arrow );

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
		// keep the spawn marker snapped to the latest hit-test result.
		if ( this.hitTestSource ) {

			const results = frame.getHitTestResults( this.hitTestSource );

			if ( results.length > 0 ) {

				const pose = results[ 0 ].getPose( refSpace );

				if ( ! this.hasHit ) {

					// First surface found: face away from the player.
					const xrCam = this.renderer.xr.getCamera();
					this._camPos.setFromMatrixPosition( xrCam.matrixWorld );
					this._camForward.set( 0, 0, -1 ).transformDirection( xrCam.matrixWorld );
					const yaw = Math.atan2( this._camForward.x, this._camForward.z );
					this.arQuaternion.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), yaw );

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

		this.previewGroup.position.copy( this.arPosition );
		this.previewGroup.quaternion.copy( this.arQuaternion );
		this.previewGroup.visible = this.hasHit;

		// 3) Confirm / lock
		if ( this.hasHit && this._triggerPressedEdge() ) {

			this._confirmPlacement( frame, refSpace );

		}

	}

	_applyThumbstickAdjustment( dt ) {

		const axesR = this.gamepads.right ? this.gamepads.right.axes : [];
		const axesL = this.gamepads.left ? this.gamepads.left.axes : [];

		const moveX = this._axis( axesR, 2 );
		const moveY = this._axis( axesR, 3 );
		const rotX = this._axis( axesL, 2 );

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

		if ( this.world ) {

			this._buildFreeRoamFloor( frame );
			this._buildRoomFurnitureColliders( frame, refSpace );

		}

		if ( this.onPlaced ) this.onPlaced( this.getSpawnWorld() );

	}

	// Static floor collider for the car to drive on. Sized to the real
	// detected floor plane if plane-detection is available, else falls
	// back to a generous flat area around the spawn point.
	_buildFreeRoamFloor( frame ) {

		let halfW = 8, halfD = 8; // generous 16x16m fallback

		try {

			const planes = frame ? frame.detectedPlanes : null;

			if ( planes && planes.size > 0 ) {

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

					const area = ( maxX - minX ) * ( maxZ - minZ );
					if ( area > bestArea ) {

						bestArea = area;
						best = { hw: ( maxX - minX ) / 2, hd: ( maxZ - minZ ) / 2 };

					}

				} );

				if ( best ) {

					halfW = Math.max( best.hw, 1 );
					halfD = Math.max( best.hd, 1 );

				}

			}

		} catch ( e ) {

			console.warn( '[ARManager] plane-detection floor sizing unavailable, using fallback:', e );

		}

		rigidBody.create( this.world, {
			shape: box.create( { halfExtents: [ halfW, 0.01, halfD ] } ),
			motionType: MotionType.STATIC,
			objectLayer: this.world._OL_STATIC,
			position: [ this.arPosition.x, this.arPosition.y - 0.125, this.arPosition.z ],
			friction: 5.0,
			restitution: 0.0,
		} );

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

	getSpawnWorld() {

		const yaw = new THREE.Euler().setFromQuaternion( this.arQuaternion, 'YXZ' ).y;
		// Match NORMAL mode's convention of spawning the sphere ~0.5m above
		// the floor (see Track.js computeSpawnPosition) rather than exactly
		// at the detected floor height, which left it embedded in the floor.
		const position = this.arPosition.clone();
		position.y += 0.5;

		return { position, angle: yaw };

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

	// Left stick is unused while driving (steering/throttle/brake are on
	// the right stick + triggers) — free to repurpose for live resizing.
	// Returns a value in [-1, 1]; main.js turns this into a scale change.
	getScaleAdjustInput() {

		const axesL = this.gamepads.left ? this.gamepads.left.axes : [];
		return this._axis( axesL, 3 );

	}

	_onSessionEnd() {

		this.session = null;
		this.hitTestSource = null;
		this.hitTestSourceRequested = false;

		if ( this._savedBackground !== null ) this.scene.background = this._savedBackground;
		this.scene.fog = this._savedFog;

		this.previewGroup.visible = false;

	}

}
