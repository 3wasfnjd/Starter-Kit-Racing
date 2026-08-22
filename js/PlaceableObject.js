import * as THREE from 'three';

// Reusable "pick it up like a real object" controller for AR — this is
// the shared mechanic behind the floating track and floating arena
// (Stage 2: tested standalone on a placeholder box before either of
// those is wired up).
//
// Interaction:
//  - Bring either controller within GRAB_RANGE of the object and hold
//    that hand's thumbstick-click button (xr-standard index 3) — the
//    object then tracks that controller's position/orientation exactly
//    (offset preserved from the moment of grab, so it doesn't jump).
//  - Release the button — the object stays wherever it was left.
//  - Left stick Y-axis (while not grabbing with the left hand) scales
//    the object up/down, matching the same axis already used for the
//    vehicle resize control in room-drive AR mode.
//  - Trigger (xr-standard index 0), from either hand — confirms/locks
//    the current position and scale. Fires onConfirm() once; grabbing
//    and scaling are disabled after that.

const GRAB_RANGE = 0.35; // meters
const MIN_SCALE = 0.05;
const MAX_SCALE = 1.5;
const SCALE_SPEED = 0.8; // per second at full stick deflection

export class PlaceableObject {

	constructor( object, arManager ) {

		this.object = object;
		this.arManager = arManager;

		this.locked = false;
		this.onConfirm = null;

		this._grabbedHand = null; // 'left' | 'right' | null
		this._grabOffset = new THREE.Vector3();
		this._grabQuatOffset = new THREE.Quaternion();

		this._prevStickClick = { left: false, right: false };
		this._prevTrigger = { left: false, right: false };

		this._tmpPos = new THREE.Vector3();
		this._tmpQuat = new THREE.Quaternion();
		this._invQuat = new THREE.Quaternion();

	}

	update( dt ) {

		if ( this.locked ) return;

		const gamepads = this.arManager.gamepads;
		const controllers = this.arManager.controllers;

		for ( const hand of [ 'left', 'right' ] ) {

			const gp = gamepads[ hand ];
			const controller = controllers[ hand ];
			if ( ! gp || ! controller ) continue;

			const stickClick = gp.buttons[ 3 ] ? gp.buttons[ 3 ].pressed : false;
			const stickClickEdge = stickClick && ! this._prevStickClick[ hand ];
			this._prevStickClick[ hand ] = stickClick;

			if ( this._grabbedHand === hand ) {

				if ( ! stickClick ) {

					this._grabbedHand = null; // released

				} else {

					// Follow this controller's current pose, preserving
					// the offset recorded at grab time so the object
					// doesn't snap to the controller's exact position.
					this._tmpQuat.copy( controller.quaternion ).multiply( this._grabQuatOffset );
					this._tmpPos.copy( this._grabOffset ).applyQuaternion( controller.quaternion ).add( controller.position );

					this.object.position.copy( this._tmpPos );
					this.object.quaternion.copy( this._tmpQuat );

				}

			} else if ( this._grabbedHand === null && stickClickEdge ) {

				const dist = controller.position.distanceTo( this.object.position );
				if ( dist <= GRAB_RANGE ) {

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

			if ( trigEdge ) {

				this.locked = true;
				this._grabbedHand = null;
				if ( this.onConfirm ) this.onConfirm();
				return;

			}

		}

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
					const newScale = THREE.MathUtils.clamp( this.object.scale.x * factor, MIN_SCALE, MAX_SCALE );
					this.object.scale.setScalar( newScale );

				}

			}

		}

	}

}
