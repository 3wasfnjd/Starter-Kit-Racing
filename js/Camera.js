import * as THREE from 'three';

const _desired = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _lookPoint = new THREE.Vector3();

// ─── Cockpit (driver's-seat) view ───────────────────────────
// Every previous eye position here was a guess, and guessing is what
// kept getting this wrong (embedded in the dashboard, "outside" the
// cabin, etc.) — so this round the actual GLB (vehicle-truck-*.glb) was
// inspected directly instead: its "body" node is ONE SOLID mesh, no
// separate glass/interior/steering-wheel geometry at all, with local
// bounds x:[-0.75,0.75] y:[-0.1,0.9] z:[-1.4,1.4] (1.5m wide, 1m tall,
// 2.8m long). There is no hollow cabin and no steering wheel to look
// at — the "windshield" is just a painted/textured area on that solid
// surface, not an opening. Any eye position inside that box sits INSIDE
// solid triangles, which is exactly the giant-blown-up-yellow-polygon
// clipping mess reported from the last version (z=-0.02 was inside the
// mesh, not "outside the cabin" as first guessed).
// Converting to container-local space (body sits at container-y≈0.3):
// the solid mesh spans y:[0.2,1.2], z:[-1.4,1.4] — so ANY collision-free
// forward-facing eye position has to sit above y≈1.2 (there's no way to
// dodge it sideways or lengthwise and still face forward through where
// the "windshield" reads visually). That's the same height band the
// existing headlight bar already safely uses ("clear above the roof,
// open air" — body-local y=1.05 there converts to this same ~1.3
// container-space height), so this reuses that already-validated clear
// zone: a roof/hood-mounted camera, not a literal seated-inside view
// (which this model has no geometry to support). Shows the hood and the
// windshield's painted area from just above/behind them, tilted down.
const COCKPIT_EYE_OFFSET = new THREE.Vector3( -0.2, 1.3, 0.4 );
const LOOK_PITCH_DOWN = 0.55;
const _cockpitEyeWorld = new THREE.Vector3();
const _cockpitLookTarget = new THREE.Vector3();

// ─── Procedural steering wheel + dashboard hint ─────────────
// Stylized, primitive-geometry props — NOT modeled from the real GLB
// (which, per the inspection above, has no wheel/dash geometry to copy).
// Positioning is deliberately conservative: everything here sits in the
// SAME validated clear-air band as COCKPIT_EYE_OFFSET (y≈1.2-1.35, above
// the solid body mesh's measured roof line at container-space y≈1.2, and
// below the already-proven-safe headlight bar at y≈1.35) rather than
// anywhere near the hood/roof surface itself — after three straight
// guesses that ended up embedded in solid geometry, a fourth guess that
// touches that surface again isn't worth the risk for a purely
// decorative prop. So the "dashboard" reads as a raked hint-plate
// floating just below the wheel, not a plate resting on the hood.
const WHEEL_TILT = 0.5; // rotation about X — matches the eye's look-pitch, so the ring/dash face the camera roughly square-on
const WHEEL_CENTER = new THREE.Vector3( -0.16, 1.27, 0.58 );
const DASH_CENTER = new THREE.Vector3( -0.02, 1.24, 0.66 );

export function createCockpitProps() {

	const group = new THREE.Group();
	group.name = 'cockpitProps';

	const trimMat = new THREE.MeshStandardMaterial( { color: 0x1a1a1a, roughness: 0.7, metalness: 0.1 } );

	// Steering wheel: rim + hub + 3 spokes, built flat in the group's local
	// XY plane (a torus's ring naturally lies in XY, hole-axis along Z),
	// then the whole wheel group is tilted about X by WHEEL_TILT so it
	// faces back toward the camera eye.
	const wheel = new THREE.Group();
	wheel.position.copy( WHEEL_CENTER );
	wheel.rotation.x = WHEEL_TILT;

	const rim = new THREE.Mesh( new THREE.TorusGeometry( 0.13, 0.014, 8, 24 ), trimMat );
	wheel.add( rim );

	const hub = new THREE.Mesh( new THREE.CylinderGeometry( 0.035, 0.035, 0.03, 12 ), trimMat );
	hub.rotation.x = Math.PI / 2; // cylinder's default axis is Y — align it with the wheel's local Z instead
	wheel.add( hub );

	const spokeGeom = new THREE.BoxGeometry( 0.12, 0.018, 0.018 );
	spokeGeom.translate( 0.06, 0, 0 ); // one end at the origin so rotating about Z fans it out from the hub, not from its own center
	for ( let i = 0; i < 3; i ++ ) {

		const spoke = new THREE.Mesh( spokeGeom, trimMat );
		spoke.rotation.z = ( i / 3 ) * Math.PI * 2;
		wheel.add( spoke );

	}

	group.add( wheel );

	// Dashboard hint: a small raked plate just below the wheel, same tilt,
	// same clear-air band — a silhouette suggestion rather than a modeled dash.
	const dash = new THREE.Mesh( new THREE.BoxGeometry( 0.5, 0.03, 0.16 ), trimMat );
	dash.position.copy( DASH_CENTER );
	dash.rotation.x = WHEEL_TILT;
	group.add( dash );

	return group;

}

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
		// 'cockpit' = roof/hood-mounted forward view (updateCockpit()) —
		// see COCKPIT_EYE_OFFSET's comment above for why it's mounted
		// there rather than literally "inside" the car.
		this.view = 'chase';
		this.chaseFov = 40;
		this.cockpitFov = 68; // wider — sitting this close to the car needs a bigger FOV to still see around
		this.chaseNear = 0.1; // the constructor's original default — chase sits ~16m out, irrelevant there
		this.cockpitNear = 0.05; // hood/roof surface sits fairly close below/ahead of this camera

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
		this.camera.near = this.view === 'cockpit' ? this.cockpitNear : this.chaseNear;
		this.camera.updateProjectionMatrix();

	}

	// vehicleContainer is `vehicle.container` — its .position/.quaternion
	// are only true WORLD position/rotation when its parent is `scene`
	// itself at identity transform, which is the case in NORMAL/web mode
	// (the only mode this class is used in — AR modes render through the
	// headset's own head-tracked camera instead, with no equivalent
	// currently; an earlier AR "dash-cam" viewport attempt was removed).
	updateCockpit( vehicleContainer ) {

		_cockpitEyeWorld.copy( COCKPIT_EYE_OFFSET ).applyQuaternion( vehicleContainer.quaternion ).add( vehicleContainer.position );
		this.camera.position.copy( _cockpitEyeWorld );

		// Look mostly down the model's own forward (+Z), with a slight
		// downward pitch (LOOK_PITCH_DOWN) so the hood is visible in the
		// lower part of the frame instead of the view sitting dead level
		// and showing only sky/horizon over the top of it. Not a plain
		// quaternion copy — a THREE.Camera's own "forward" is its local
		// -Z, so that would have it looking exactly backward.
		_cockpitLookTarget.set( 0, - LOOK_PITCH_DOWN, 1 ).applyQuaternion( vehicleContainer.quaternion ).add( _cockpitEyeWorld );
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
