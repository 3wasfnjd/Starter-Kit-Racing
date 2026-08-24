import * as THREE from 'three';

const _desired = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _lookPoint = new THREE.Vector3();

// ─── Cockpit (driver's-seat) view ───────────────────────────
// Approximate driver eye position, local to the vehicle's own container
// coordinate frame: left side (Saudi Arabia is left-hand-drive, matching
// the same side=-1 convention already used for the flag/taillights in
// main.js), roughly seated eye height, just behind the windshield.
// +Z is the model's forward direction (matches the headlight/flag/decal
// coordinates in main.js — windshield decal sits at +z, tailgate at -z).
// This is an estimate, not measured from the GLB directly (no way to
// inspect the model visually from here) — may need a small manual nudge
// after an actual in-browser look.
const COCKPIT_EYE_OFFSET = new THREE.Vector3( -0.32, 0.85, 0.1 );
const _cockpitEyeWorld = new THREE.Vector3();
const _cockpitLookTarget = new THREE.Vector3();

export class Camera {

	constructor() {

		this.camera = new THREE.PerspectiveCamera( 40, window.innerWidth / window.innerHeight, 0.1, 60 );

		// Matches Godot View: 45° azimuth, 35° elevation, distance 16
		this.offset = new THREE.Vector3( 9.27, 9.18, 9.27 );

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		// Camera-aligned ground basis (XZ plane), derived from offset.
		// camRightXZ: screen-right projected to ground.
		// camForwardXZ: screen-up (away from camera) projected to ground.
		this.camRightXZ = new THREE.Vector3( this.offset.z, 0, - this.offset.x ).normalize();
		this.camForwardXZ = new THREE.Vector3( - this.offset.x, 0, - this.offset.z ).normalize();

		this.leadFactor = 3.0;
		this.cameraSmoothing = 2.0;
		this.deadzoneRadius = 5.0;
		this.screenShiftUp = 1.0;

		this.smoothedDesired = new THREE.Vector3();
		this.initialized = false;

		// 'chase' = the existing Godot-style trailing camera (update()).
		// 'cockpit' = seated driver's-seat view (updateCockpit()).
		this.view = 'chase';
		this.chaseFov = 40;
		this.cockpitFov = 68; // wider — sitting close to the windshield needs a bigger FOV to still see around

		const segments = 64;
		const points = [];
		for ( let i = 0; i <= segments; i ++ ) {

			const a = ( i / segments ) * Math.PI * 2;
			points.push( new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) ) );

		}
		const dzGeom = new THREE.BufferGeometry().setFromPoints( points );
		this.debug = new THREE.Line( dzGeom, new THREE.LineBasicMaterial( { color: 0xff00ff, depthTest: false } ) );
		this.debug.visible = false;
		this.debug.renderOrder = 999;
		this.debug.quaternion.setFromRotationMatrix(
			new THREE.Matrix4().makeBasis( this.camRightXZ, new THREE.Vector3( 0, 1, 0 ), this.camForwardXZ )
		);

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}

	toggleView() {

		this.view = this.view === 'chase' ? 'cockpit' : 'chase';
		this.camera.fov = this.view === 'cockpit' ? this.cockpitFov : this.chaseFov;
		this.camera.updateProjectionMatrix();

	}

	// vehicleContainer is `vehicle.container` — its .position/.quaternion
	// are only true WORLD position/rotation when its parent is `scene`
	// itself at identity transform, which is the case in NORMAL/web mode
	// (the only mode this class is used in — AR modes render through the
	// headset's own head-tracked camera instead, see the separate AR
	// "dash-cam" cockpit viewport in main.js for the AR equivalent).
	updateCockpit( vehicleContainer ) {

		_cockpitEyeWorld.copy( COCKPIT_EYE_OFFSET ).applyQuaternion( vehicleContainer.quaternion ).add( vehicleContainer.position );
		this.camera.position.copy( _cockpitEyeWorld );

		// Look straight down the model's own forward (+Z) rather than
		// copying the container's quaternion directly onto the camera —
		// a THREE.Camera's own "forward" is its local -Z, so a plain
		// quaternion copy would have it looking exactly backward.
		_cockpitLookTarget.set( 0, 0, 1 ).applyQuaternion( vehicleContainer.quaternion ).add( _cockpitEyeWorld );
		this.camera.lookAt( _cockpitLookTarget );

	}

	update( dt, target, velocity ) {

		const radius = this.deadzoneRadius;
		const radiusSq = radius * radius;

		// Lead = velocity projected onto camera-aligned ground basis, scaled, clamped to the deadzone disk.
		// Becomes the camera's offset from the car: car settles at the trailing edge of the circle.
		let leadX = velocity.dot( this.camRightXZ ) * this.leadFactor;
		let leadY = velocity.dot( this.camForwardXZ ) * this.leadFactor;
		const leadLenSq = leadX * leadX + leadY * leadY;
		if ( leadLenSq > radiusSq ) {

			const k = radius / Math.sqrt( leadLenSq );
			leadX *= k;
			leadY *= k;

		}

		_desired.copy( target )
			.addScaledVector( this.camRightXZ, leadX )
			.addScaledVector( this.camForwardXZ, leadY );

		const alpha = this.initialized ? 1 - Math.exp( - dt * this.cameraSmoothing ) : 1;
		this.smoothedDesired.lerp( _desired, alpha );
		this.initialized = true;

		// Hard-clamp: car must not escape the deadzone, even if the lerp lags at high speed.
		_delta.subVectors( target, this.smoothedDesired );
		const offsetX = _delta.dot( this.camRightXZ );
		const offsetY = _delta.dot( this.camForwardXZ );
		const offsetLenSq = offsetX * offsetX + offsetY * offsetY;
		if ( offsetLenSq > radiusSq ) {

			const offsetLen = Math.sqrt( offsetLenSq );
			const k = ( offsetLen - radius ) / offsetLen;
			this.smoothedDesired
				.addScaledVector( this.camRightXZ, offsetX * k )
				.addScaledVector( this.camForwardXZ, offsetY * k );

		}

		// Shift the entire view (camera + lookAt) so smoothedDesired sits higher on screen.
		_lookPoint.copy( this.smoothedDesired ).addScaledVector( this.camForwardXZ, - this.screenShiftUp );

		this.camera.position.copy( _lookPoint ).add( this.offset );
		this.camera.lookAt( _lookPoint );

		this.debug.position.copy( this.smoothedDesired );
		this.debug.position.y += 0.05;
		this.debug.scale.set( radius, 1, radius );

	}

}
