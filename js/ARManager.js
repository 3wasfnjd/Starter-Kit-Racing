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

		this.previewGroup = this.buildPreviewMesh();
		this.arTrackRoot.add( this.previewGroup );

		this.world = null; // set by main.js via setWorld() before session start
		this.spawnLocal = computeSpawnPosition( customCells );

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
			grip.add( this.controllerModelFactory.createControllerModel( grip ) );
			this.scene.add( grip );

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

		const refSpace = this.renderer.xr.getReferenceSpace();

		if ( ! this.hitTestSourceRequested ) {

			this.hitTestSourceRequested = true;
			this.session.requestReferenceSpace( 'viewer' ).then( ( viewerSpace ) => {

				this.session.requestHitTestSource( { space: viewerSpace } ).then( ( source ) => {

					this.hitTestSource = source;

				} );

			} );

		}

		if ( ! this.placed ) {

			this._updatePlacement( frame, refSpace, dt );

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

					// First surface found: face the track away from the player.
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

		this.arTrackRoot.position.copy( this.arPosition );
		this.arTrackRoot.quaternion.copy( this.arQuaternion );
		this.arTrackRoot.scale.setScalar( this.arScale );

		this.previewGroup.visible = this.hasHit;

		// 3) Confirm / lock
		if ( this.hasHit && this._triggerPressedEdge() ) {

			this._confirmPlacement();

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

	_confirmPlacement() {

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

		}

		if ( this.onPlaced ) this.onPlaced( this.getSpawnWorld() );

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
