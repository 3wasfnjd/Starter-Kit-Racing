import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// VRManager: minimal WebXR VR session + controller-input handling for the
// self-built VR test room (see startVRTestRoom() in main.js). Deliberately
// does NOT reuse/extend ARManager — ARManager carries a lot of AR-only
// weight (hit-test placement, mesh-detection, passthrough background/fog
// save-restore) this mode has no use for, since the room here is built by
// us, not scanned from the real world. There's no placement phase either:
// the room's layout is known upfront, so the car spawns immediately at
// room center once the session starts.
//
// What IS shared with ARManager — the controller setup and the small
// per-frame input-query getters below — is copied rather than abstracted
// into a common base class: it's simple, stable, and small enough
// (~150 lines) that a shared base isn't worth the risk of touching
// ARManager's own working, real-device-tested code just to enable it.

const DEADZONE = 0.15;

export class VRManager {

	constructor( { renderer, scene } ) {

		this.renderer = renderer;
		this.scene = scene;

		this.session = null;

		this.gamepads = { left: null, right: null };
		this.controllers = { left: null, right: null };
		this._prevHeadlightButton = false;
		this._prevHazardButton = false;
		this._prevMenuButton = false;

		this.controllerModelFactory = new XRControllerModelFactory();
		this._setupControllers();

		this._savedBackground = null;
		this._savedFog = null;

	}

	// ─── UI entry point ───────────────────────────────────

	static async isSupported() {

		if ( ! navigator.xr ) return false;
		try {

			return await navigator.xr.isSessionSupported( 'immersive-vr' );

		} catch ( e ) {

			return false;

		}

	}

	async requestSession( pendingSession = null ) {

		const session = pendingSession ? await pendingSession : await navigator.xr.requestSession( 'immersive-vr', {
			requiredFeatures: [ 'local-floor' ],
		} );

		this.renderer.xr.setReferenceSpaceType( 'local-floor' );
		await this.renderer.xr.setSession( session );

		this.session = session;
		session.addEventListener( 'end', () => this._onSessionEnd() );

		this._savedBackground = this.scene.background;
		this._savedFog = this.scene.fog;

		console.log( '[VRManager] VR session started.' );

		return session;

	}

	// ─── Controllers ──────────────────────────────────────
	// Identical setup to ARManager._setupControllers() — see that
	// method's own comments for why each piece is there.

	_setupControllers() {

		for ( let i = 0; i < 2; i ++ ) {

			const controller = this.renderer.xr.getController( i );
			controller.addEventListener( 'connected', ( event ) => {

				const hand = event.data.handedness === 'left' ? 'left' : 'right';
				this.gamepads[ hand ] = event.data.gamepad || null;
				this.controllers[ hand ] = controller;

			} );
			controller.addEventListener( 'disconnected', ( event ) => {

				const hand = event.data.handedness === 'left' ? 'left' : 'right';
				this.gamepads[ hand ] = null;

			} );
			this.scene.add( controller );

			const grip = this.renderer.xr.getControllerGrip( i );
			this.scene.add( grip );

			// Cosmetic only — never let a failure here break driving.
			try {

				grip.add( this.controllerModelFactory.createControllerModel( grip ) );

			} catch ( e ) {

				console.warn( '[VRManager] Controller model failed to load (non-fatal):', e );

			}

		}

	}

	_axis( axes, index ) {

		const v = axes && axes.length > index ? axes[ index ] : 0;
		return Math.abs( v ) > DEADZONE ? v : 0;

	}

	// ─── Driving input — same {x, z} contract Vehicle.update() expects, ──
	// ─── same control mapping as ARManager's own getDriveInput()/       ──
	// ─── button getters (right stick steers, right trigger/grip         ──
	// ─── throttles, left trigger brakes, etc.).                         ──

	getDriveInput() {

		const axesR = this.gamepads.right ? this.gamepads.right.axes : [];
		const x = this._axis( axesR, 2 );

		const rTrig = this.gamepads.right && this.gamepads.right.buttons[ 0 ] ? this.gamepads.right.buttons[ 0 ].value : 0;
		const rGrip = this.gamepads.right && this.gamepads.right.buttons[ 1 ] ? this.gamepads.right.buttons[ 1 ].value : 0;
		const lTrig = this.gamepads.left && this.gamepads.left.buttons[ 0 ] ? this.gamepads.left.buttons[ 0 ].value : 0;

		const z = Math.max( rTrig, rGrip ) - lTrig;

		return { x, z, touchActive: false };

	}

	// Left stick unused while driving — repurposed for live car resizing,
	// same as ARManager's own getScaleAdjustInput().
	getScaleAdjustInput() {

		const left = this.gamepads.left;
		if ( ! left || ! left.axes ) return 0;

		const a3 = left.axes.length > 3 ? left.axes[ 3 ] : 0;
		const a1 = left.axes.length > 1 ? left.axes[ 1 ] : 0;
		const v = Math.abs( a3 ) > Math.abs( a1 ) ? a3 : a1;

		return Math.abs( v ) > 0.25 ? v : 0;

	}

	getHeadlightToggle() {

		const right = this.gamepads.right;
		const pressed = right && right.buttons[ 3 ] ? right.buttons[ 3 ].pressed : false;
		const edge = pressed && ! this._prevHeadlightButton;
		this._prevHeadlightButton = pressed;
		return edge;

	}

	getHazardToggle() {

		const right = this.gamepads.right;
		const pressed = right && right.buttons[ 4 ] ? right.buttons[ 4 ].pressed : false;
		const edge = pressed && ! this._prevHazardButton;
		this._prevHazardButton = pressed;
		return edge;

	}

	getHighBeamHold() {

		const right = this.gamepads.right;
		return right && right.buttons[ 5 ] ? right.buttons[ 5 ].pressed : false;

	}

	getMenuButtonPress() {

		const left = this.gamepads.left;
		const pressed = left && left.buttons[ 6 ] ? left.buttons[ 6 ].pressed : false;
		const edge = pressed && ! this._prevMenuButton;
		this._prevMenuButton = pressed;
		return edge;

	}

	getHornHold() {

		const left = this.gamepads.left;
		return left && left.buttons[ 1 ] ? left.buttons[ 1 ].pressed : false;

	}

	getHandbrakeHold() {

		const left = this.gamepads.left;
		return left && left.buttons[ 3 ] ? left.buttons[ 3 ].pressed : false;

	}

	_onSessionEnd() {

		this.session = null;
		if ( this._savedBackground !== null ) this.scene.background = this._savedBackground;
		this.scene.fog = this._savedFog;

	}

}
