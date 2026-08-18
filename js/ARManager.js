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
		this._prevRadioButtons = { x: false, y: false };
		this._prevHeadlightButton = false;
		this._prevHazardButton = false;

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

	async requestSession( pendingSession = null ) {

		const session = pendingSession ? await pendingSession : await navigator.xr.requestSession( 'immersive-ar', {
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

			} else {

				this._updateDebugHUD();

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

			this._buildFreeRoamFloor();
			this._buildRoomFurnitureColliders( frame, refSpace );

		}

		if ( this.onPlaced ) this.onPlaced( this.getSpawnWorld() );

	}

	// Static floor collider for the car to drive on, plus solid perimeter
	// walls so the car bounces off the boundary instead of driving past
	// the edge into the void and falling. Always generous and fixed-size —
	// trusting plane-detection's reported floor size was causing an
	// undersized collider (a mislabeled or partially-scanned surface).
	_buildFreeRoamFloor() {

		// ─────────────────────────────────────────────────────────
		// ✏️ TO RESIZE THE AR PLAY AREA: change this one number (in
		// meters — half the width/depth, so 40 = an 80x80m square).
		const AR_FLOOR_HALF_SIZE = 40;
		// ─────────────────────────────────────────────────────────

		const halfW = AR_FLOOR_HALF_SIZE, halfD = AR_FLOOR_HALF_SIZE;
		const floorY = this.arPosition.y - 0.125;
		const cx = this.arPosition.x, cz = this.arPosition.z;

		rigidBody.create( this.world, {
			shape: box.create( { halfExtents: [ halfW, 0.01, halfD ] } ),
			motionType: MotionType.STATIC,
			objectLayer: this.world._OL_STATIC,
			position: [ cx, floorY, cz ],
			friction: 5.0,
			restitution: 0.0,
		} );

		const wallHalfHeight = 1.0;
		const wallThickness = 0.2;
		const wallY = floorY + wallHalfHeight;

		// North / South (along X, thin in Z)
		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( this.world, {
				shape: box.create( { halfExtents: [ halfW, wallHalfHeight, wallThickness ] } ),
				motionType: MotionType.STATIC,
				objectLayer: this.world._OL_STATIC,
				position: [ cx, wallY, cz + sign * halfD ],
				friction: 0.2,
				restitution: 0.3,
			} );

		}

		// East / West (along Z, thin in X)
		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( this.world, {
				shape: box.create( { halfExtents: [ wallThickness, wallHalfHeight, halfD ] } ),
				motionType: MotionType.STATIC,
				objectLayer: this.world._OL_STATIC,
				position: [ cx + sign * halfW, wallY, cz ],
				friction: 0.2,
				restitution: 0.3,
			} );

		}

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

		const left = this.gamepads.left;
		if ( ! left || ! left.axes ) return 0;

		// Different browser/firmware builds have occasionally reported the
		// thumbstick Y axis at index 1 instead of the xr-standard index 3 —
		// check both and use whichever has a real signal.
		const a3 = left.axes.length > 3 ? left.axes[ 3 ] : 0;
		const a1 = left.axes.length > 1 ? left.axes[ 1 ] : 0;
		const v = Math.abs( a3 ) > Math.abs( a1 ) ? a3 : a1;

		return Math.abs( v ) > 0.25 ? v : 0; // slightly larger deadzone than steering

	}

	// Left X/Y buttons (xr-standard indices 4/5) are completely unused
	// during driving — repurposed here for radio control. Returns
	// rising-edge booleans (true only on the frame the button was first
	// pressed), so main.js can react once per press rather than every frame.
	getRadioButtons() {

		const left = this.gamepads.left;
		const xBtn = left && left.buttons[ 4 ] ? left.buttons[ 4 ].pressed : false;
		const yBtn = left && left.buttons[ 5 ] ? left.buttons[ 5 ].pressed : false;

		const xEdge = xBtn && ! this._prevRadioButtons.x;
		const yEdge = yBtn && ! this._prevRadioButtons.y;

		this._prevRadioButtons.x = xBtn;
		this._prevRadioButtons.y = yBtn;

		return { next: xEdge, toggle: yEdge };

	}

	// Left thumbstick click (xr-standard index 3) — switched away from
	// left grip, which proved unreliable for scale-adjust earlier
	// (squeeze sensors often need an unusually firm press). Rising-edge.
	// Right thumbstick click (xr-standard index 3). Moved here after both
	// left-hand attempts (grip, then left-stick-click) failed to
	// register reliably, while every right-hand button tried so far
	// (hazards on A) has worked — switching hands as the fix.
	// TEMPORARY diagnostic HUD — floats in front of the player once driving,
	// showing every button's raw pressed state on both controllers. Meant
	// to find out exactly which button index actually registers when
	// physically pressed, after several guessed mappings didn't work.
	// Safe to remove once headlights are sorted out.
	_updateDebugHUD() {

		if ( ! this._debugCtx ) {

			const canvas = document.createElement( 'canvas' );
			canvas.width = 700;
			canvas.height = 420;
			this._debugCtx = canvas.getContext( '2d' );
			this._debugTexture = new THREE.CanvasTexture( canvas );
			const material = new THREE.MeshBasicMaterial( {
				map: this._debugTexture, transparent: true, depthTest: false,
			} );
			this._debugMesh = new THREE.Mesh( new THREE.PlaneGeometry( 0.9, 0.54 ), material );
			this._debugMesh.renderOrder = 999;
			this.scene.add( this._debugMesh );

		}

		const xrCam = this.renderer.xr.getCamera();
		const camPos = new THREE.Vector3().setFromMatrixPosition( xrCam.matrixWorld );
		const camQuat = new THREE.Quaternion().setFromRotationMatrix( xrCam.matrixWorld );
		const forward = new THREE.Vector3( 0, 0, -1 ).applyQuaternion( camQuat );
		this._debugMesh.position.copy( camPos ).addScaledVector( forward, 1.0 );
		this._debugMesh.quaternion.copy( camQuat );

		const ctx = this._debugCtx;
		const W = 700, H = 420;
		ctx.clearRect( 0, 0, W, H );
		ctx.fillStyle = 'rgba(10,10,10,0.88)';
		ctx.fillRect( 0, 0, W, H );
		ctx.font = '20px monospace';

		// Two side-by-side columns so nothing gets cut off vertically.
		const columns = [ { hand: 'left', x: 16 }, { hand: 'right', x: 366 } ];

		for ( const { hand, x } of columns ) {

			let y = 30;
			const gp = this.gamepads[ hand ];
			ctx.fillStyle = '#fff';
			ctx.fillText( hand.toUpperCase() + ': ' + ( gp ? 'connected' : 'not connected' ), x, y );
			y += 30;

			if ( gp && gp.buttons ) {

				for ( let i = 0; i < gp.buttons.length; i ++ ) {

					const b = gp.buttons[ i ];
					ctx.fillStyle = b.pressed ? '#4CAF6D' : '#999';
					ctx.fillText( `[${ i }] pressed=${ b.pressed }`, x, y );
					y += 26;
					ctx.fillText( `    value=${ b.value.toFixed( 2 ) }`, x, y );
					y += 30;

				}

			}

			if ( gp && gp.axes ) {

				ctx.fillStyle = '#ffd54f';
				ctx.fillText( 'axes: ' + gp.axes.map( ( a ) => a.toFixed( 2 ) ).join( ', ' ), x, y );

			}

		}

		this._debugTexture.needsUpdate = true;

	}

	getHeadlightToggle() {

		const right = this.gamepads.right;
		const pressed = right && right.buttons[ 3 ] ? right.buttons[ 3 ].pressed : false;
		const edge = pressed && ! this._prevHeadlightButton;
		this._prevHeadlightButton = pressed;
		return edge;

	}

	// Right A/X button (xr-standard index 4) is unused elsewhere while
	// driving — repurposed for hazard-light toggle. Rising-edge only.
	getHazardToggle() {

		const right = this.gamepads.right;
		const pressed = right && right.buttons[ 4 ] ? right.buttons[ 4 ].pressed : false;
		const edge = pressed && ! this._prevHazardButton;
		this._prevHazardButton = pressed;
		return edge;

	}

	// Right B/Y button (xr-standard index 5) — high beam, held not
	// toggled, matching a real high-beam flasher stalk. Returns the raw
	// pressed state every frame (not edge-detected).
	getHighBeamHold() {

		const right = this.gamepads.right;
		return right && right.buttons[ 5 ] ? right.buttons[ 5 ].pressed : false;

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
