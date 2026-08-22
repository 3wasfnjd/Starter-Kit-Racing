import * as THREE from 'three';

// Reusable "pick it up like a real object" controller for AR — this is
// the shared mechanic behind the floating track and floating arena
// (Stage 2: tested standalone on a placeholder box before either of
// those is wired up).
//
// Interaction:
//  - Bring either controller within GRAB_RANGE of the object — it lights
//    up (emissive glow) so it's obvious you're close enough, even before
//    touching anything.
//  - While lit up, hold that hand's GRIP/squeeze button (xr-standard
//    index 1 — closing your hand around the controller, the standard
//    "grab" gesture in VR/AR) — the object then tracks that controller's
//    position/orientation exactly (offset preserved from the moment of
//    grab, so it doesn't jump).
//  - Release the grip — the object stays wherever it was left.
//  - Left stick Y-axis (while not grabbing with the left hand) scales
//    the object up/down, matching the same axis already used for the
//    vehicle resize control in room-drive AR mode.
//  - Trigger (xr-standard index 0), from either hand — fires onConfirm()
//    once (e.g. to start the race). Grabbing and scaling stay available
//    afterward too — confirming doesn't lock the object in place, since
//    the whole point is being able to keep adjusting position/size
//    whenever you want, even mid-race.

const GRAB_RANGE = 0.5; // meters — generous on purpose, easier to find than to fine-tune
const DEFAULT_MIN_SCALE = 0.05;
const DEFAULT_MAX_SCALE = 1.5;
const SCALE_SPEED = 0.8; // per second at full stick deflection

export class PlaceableObject {

	constructor( object, arManager, { minScale = DEFAULT_MIN_SCALE, maxScale = DEFAULT_MAX_SCALE } = {} ) {

		this.object = object;
		this.arManager = arManager;
		this.minScale = minScale;
		this.maxScale = maxScale;

		this.confirmed = false;
		this.onConfirm = null;

		this._grabbedHand = null; // 'left' | 'right' | null
		this._grabOffset = new THREE.Vector3();
		this._grabQuatOffset = new THREE.Quaternion();

		this._prevGrip = { left: false, right: false };
		this._prevTrigger = { left: false, right: false };

		this._tmpPos = new THREE.Vector3();
		this._tmpQuat = new THREE.Quaternion();
		this._invQuat = new THREE.Quaternion();

		// Visual proximity feedback — every material on the object
		// glows white-ish when a controller is in grab range, and glows
		// brighter/warmer while actually being held. Wrapped in
		// try/catch since not every material type supports emissive.
		this._materials = [];
		object.traverse( ( c ) => { if ( c.isMesh && c.material ) this._materials.push( c.material ); } );
		this._baseEmissive = this._materials.map( ( m ) => ( m.emissive ? m.emissive.clone() : null ) );

	}

	_setHighlight( state ) { // 'none' | 'near' | 'held'

		this._materials.forEach( ( m, i ) => {

			if ( ! m.emissive ) return;
			if ( state === 'held' ) m.emissive.setRGB( 0.5, 0.4, 0.05 );
			else if ( state === 'near' ) m.emissive.setRGB( 0.25, 0.25, 0.3 );
			else m.emissive.copy( this._baseEmissive[ i ] );

		} );

	}

	update( dt ) {

		const gamepads = this.arManager.gamepads;
		const controllers = this.arManager.controllers;

		let nearestDist = Infinity;

		for ( const hand of [ 'left', 'right' ] ) {

			const gp = gamepads[ hand ];
			const controller = controllers[ hand ];
			if ( ! gp || ! controller ) continue;

			const grip = gp.buttons[ 1 ] ? gp.buttons[ 1 ].pressed : false;
			const gripEdge = grip && ! this._prevGrip[ hand ];
			this._prevGrip[ hand ] = grip;

			if ( this._grabbedHand === hand ) {

				if ( ! grip ) {

					this._grabbedHand = null; // released

				} else {

					// Follow this controller's current pose, preserving
					// the offset recorded at grab time so the object
					// doesn't snap to the controller's exact position.
					// Rotation is constrained to yaw-only (Y axis) — a
					// tilted hand otherwise tilts the whole track/arena
					// in 3D, which the physics rebuild at lock-in can't
					// represent (it only reads out a flattened yaw), so
					// an actually-tilted visual track would end up
					// mismatched from its own flat invisible colliders.
					this._tmpQuat.copy( controller.quaternion ).multiply( this._grabQuatOffset );
					const yaw = new THREE.Euler().setFromQuaternion( this._tmpQuat, 'YXZ' ).y;
					this._tmpQuat.setFromEuler( new THREE.Euler( 0, yaw, 0 ) );

					this._tmpPos.copy( this._grabOffset ).applyQuaternion( controller.quaternion ).add( controller.position );

					this.object.position.copy( this._tmpPos );
					this.object.quaternion.copy( this._tmpQuat );

				}

			} else if ( this._grabbedHand === null ) {

				const dist = controller.position.distanceTo( this.object.position );
				nearestDist = Math.min( nearestDist, dist );

				if ( dist <= GRAB_RANGE && gripEdge ) {

					this._grabbedHand = hand;

					// Record the object's current position/rotation
					// relative to this controller, so tracking starts
					// from exactly where things are right now.
					this._invQuat.copy( controller.quaternion ).invert();
					this._grabOffset.copy( this.object.position ).sub( controller.position ).applyQuaternion( this._invQuat );
					this._grabQuatOffset.copy( this._invQuat ).multiply( this.object.quaternion );

				}

			}

			const trig = gp.buttons[ 0 ] ? gp.buttons[ 0 ].pressed : false;
			const trigEdge = trig && ! this._prevTrigger[ hand ];
			this._prevTrigger[ hand ] = trig;

			if ( trigEdge && ! this.confirmed ) {

				this.confirmed = true;
				if ( this.onConfirm ) this.onConfirm();

			}

		}

		if ( this._grabbedHand ) this._setHighlight( 'held' );
		else if ( nearestDist <= GRAB_RANGE ) this._setHighlight( 'near' );
		else this._setHighlight( 'none' );

		// Left stick Y-axis scales the object — only while the left hand
		// isn't the one currently grabbing (avoids fighting the grab).
		if ( this._grabbedHand !== 'left' ) {

			const left = gamepads.left;
			if ( left && left.axes ) {

				const a3 = left.axes.length > 3 ? left.axes[ 3 ] : 0;
				const a1 = left.axes.length > 1 ? left.axes[ 1 ] : 0;
				const v = Math.abs( a3 ) > Math.abs( a1 ) ? a3 : a1;

				if ( Math.abs( v ) > 0.25 ) {

					const factor = 1 - v * SCALE_SPEED * dt;
					const newScale = THREE.MathUtils.clamp( this.object.scale.x * factor, this.minScale, this.maxScale );
					this.object.scale.setScalar( newScale );

				}

			}

		}

	}

}
