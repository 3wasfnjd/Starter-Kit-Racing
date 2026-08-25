import * as THREE from 'three';
import { rigidBody } from 'crashcat';

export const TOTAL_RACE_LAPS = 3;

/**
 * Professional AI Controller System
 * Handles both Track Racing (Pure Pursuit, Predictive Braking, Overtaking)
 * and Free-Roam / Hajwalah (Drift stunts, Donuts, Wall Avoidance).
 */

/**
 * Wraps an angle to (-PI, PI].
 *
 * THE ROOT CAUSE of AI cars "circling" at corners: every angle-diff in
 * this file used to be normalized with `((x + PI) % (2*PI)) - PI`. That
 * formula is only correct under a modulo that always returns a
 * non-negative result (e.g. Python's %). JavaScript's `%` is a REMAINDER
 * operator that keeps the sign of the dividend, so for any x more
 * negative than -PI (very common near a sharp bend, where the lookahead
 * target can end up almost behind the car), the old formula silently
 * failed to wrap at all and returned x unchanged — e.g. -3.19 stayed
 * -3.19 instead of wrapping to the correct +3.09. Since the AI's turn
 * DIRECTION is read off this value's sign, that bug made it commit to
 * steering the wrong rotational way whenever a corner pushed angleDiff
 * past -PI, which is exactly what produced a stable, self-sustaining
 * spin instead of the car ever turning through the bend. Verified with a
 * real-physics single-AI-car simulation (no other vehicles involved at
 * all — rules out any avoidance/multi-car explanation): with the old
 * formula the car orbited one spot near a bend for 30+ seconds straight;
 * with this fix it clears the same bend normally.
 */
function normalizeAngle( x ) {

	return ( ( ( x + Math.PI ) % ( Math.PI * 2 ) + Math.PI * 2 ) % ( Math.PI * 2 ) ) - Math.PI;

}

const _headingFwd = new THREE.Vector3();

/**
 * Robustly reads a vehicle's heading (yaw) angle.
 *
 * THE ACTUAL ROOT CAUSE of AI cars "circling" at corners — found by
 * isolating the exact moment a car's read heading jumped by over a
 * radian in a single frame with NO corresponding physical rotation, down
 * to a minimal reproduction using nothing but three.js:
 *
 *   const o = new THREE.Object3D(); o.rotation.set(0, 2.16, 0);
 *   o.rotateY(0.038);
 *   console.log(o.rotation.y);              // -> 0.943, NOT ~2.198
 *   console.log(o.rotation.x, o.rotation.z); // -> -PI, -PI  (!)
 *
 * `container.rotation.y` is the cached Euler-angle decomposition of the
 * container's quaternion, and three.js's XYZ Euler extraction is NOT
 * guaranteed to return the "obvious" (0, heading, 0) triple for a pure
 * yaw rotation — for headings roughly in the 124-360 degree range
 * (verified by sweep) it can instead return the mathematically
 * equivalent (-PI, heading', -PI), where heading' is a completely
 * different number from the true heading. Every steering calculation in
 * this file reads `container.rotation.y` directly AS the heading, so
 * crossing into that range made the AI's own read of its own heading
 * jump by over a radian with the car not having actually turned at all —
 * corrupting every subsequent angleDiff and steering decision, which is
 * exactly what produced a stable, self-sustaining spin at corners
 * instead of the car ever completing the turn (confirmed end-to-end with
 * a real-physics single-AI-car simulation: this was the true source of
 * the failure that the angle-wrap fix above and the recovery watchdogs
 * only partially masked). Reading heading off the forward VECTOR instead
 * is immune to this: it works directly from the quaternion the game
 * actually applies, with no ambiguous intermediate Euler decomposition.
 */
function getHeadingY( vehicle ) {

	_headingFwd.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
	return Math.atan2( _headingFwd.x, _headingFwd.z );

}

/**
 * Path-index priority helper for the avoidance deadlock fix below.
 * Returns true if `otherIdx` is ahead of `myIdx` on the (circular) race
 * path, i.e. "I am behind, so I should yield". Returns null on an exact
 * tie — callers break ties another way (see driverIdx comparison below).
 */
function isIndexBehind( myIdx, otherIdx, pathLen ) {

	if ( myIdx === otherIdx ) return null;
	const fwdDist = ( otherIdx - myIdx + pathLen ) % pathLen;
	return fwdDist > 0 && fwdDist <= pathLen / 2;

}

/**
 * Race AI Update
 * Uses Pure Pursuit, Curvature Predictive Braking, Racing Line Offset & Stuck Recovery.
 */
export function updateRaceAIDrivers( drivers, path, dt, racing, totalTime, playerVehicle = null ) {

	if ( ! path || path.length < 2 ) return;

	const LOOKAHEAD_BASE = 3;

	drivers.forEach( ( d, driverIdx ) => {

		const input = { x: 0, z: 0, touchActive: false, handbrake: false };

		if ( racing && ! d.finished ) {

			// 0. Start-Zone Guard (phantom first-lap fix)
			//
			// AI cars are placed on the grid BEHIND the start/finish line,
			// which in path-index terms means their starting d.idx is very
			// close to path.length (a handful of steps back from index 0 —
			// see createAIDrivers in main.js). Both the forward-window
			// search below (section 2, checks d.idx .. d.idx+8) and the
			// single-step check further down wrap around modulo
			// path.length, so for a car starting only a few indices before
			// the end, that window can reach all the way past 0 into low
			// indices on literally the FIRST frame, before the car has
			// driven anywhere — and since the start/finish line's low
			// indices are also physically right next to the car's spawn
			// point, the nearest-point search can genuinely pick one of
			// them, registering a false "wrap to 0" and counting a lap the
			// car never drove. That phantom lap is why AI cars finish
			// (i.e. reach TOTAL_RACE_LAPS) one real lap early — they only
			// ever needed to drive TOTAL_RACE_LAPS - 1 more laps after this
			// free one at the green light.
			//
			// Fixed by not trusting ANY wrap-to-low-index as a real lap
			// until the car has first been observed clearly in the middle
			// of the path (more than SAFE_ZONE_MARGIN steps from both
			// ends) — which can only happen after actually driving there.
			// Once that happens once, d.hasLeftStartZone latches true for
			// the rest of the race, so every later, genuine finish-line
			// crossing still counts normally.
			const SAFE_ZONE_MARGIN = 15;
			if ( ! d.hasLeftStartZone && path.length > SAFE_ZONE_MARGIN * 2 &&
				d.idx > SAFE_ZONE_MARGIN && d.idx < path.length - SAFE_ZONE_MARGIN ) {

				d.hasLeftStartZone = true;

			}

			// 1. Stuck Recovery Watchdog
			d.sampleTimer = ( d.sampleTimer || 0 ) + dt;
			if ( d.sampleTimer >= 0.4 ) {

				d.sampleTimer = 0;
				const moved = Math.hypot(
					d.vehicle.spherePos.x - ( d.samplePos ? d.samplePos.x : d.vehicle.spherePos.x ),
					d.vehicle.spherePos.z - ( d.samplePos ? d.samplePos.z : d.vehicle.spherePos.z )
				);
				d.samplePos = { x: d.vehicle.spherePos.x, z: d.vehicle.spherePos.z };

				if ( moved < 0.2 ) {

					d.stuckStrikes = ( d.stuckStrikes || 0 ) + 1;

				} else {

					d.stuckStrikes = 0;

				}

			}

			// 1b. Path-Progress Watchdog (circling failure mode)
			//
			// The displacement check above only catches a car that is
			// nearly motionless. It does NOT catch a car driving in a
			// tight, endless circle near a sharp corner — pure-pursuit
			// chasing a lookahead target it can never quite turn tight
			// enough to face — because that still covers roughly
			// speed*sampleInterval of ground each check, just going in
			// circles instead of forward. Verified with a real-physics
			// simulation of a single AI car (no other vehicles at all, so
			// not an avoidance issue): it got trapped orbiting one spot
			// near a bend for 30+ seconds straight, `moved` always just
			// above the 0.2 threshold, d.idx never advancing. Track path-
			// index PROGRESS directly instead: if the waypoint index
			// hasn't advanced in ~2.5s, treat it the same as being
			// physically stuck and let the resync recovery below (which
			// re-syncs to the nearest waypoint across the WHOLE path, not
			// just a forward window) snap the car back onto the racing
			// line and break the orbit.
			d.progressTimer = ( d.progressTimer || 0 ) + dt;
			if ( d.progressTimer >= 2.5 ) {

				if ( d.idx === d.lastProgressIdx ) d.stuckStrikes = Math.max( d.stuckStrikes || 0, 3 );
				d.lastProgressIdx = d.idx;
				d.progressTimer = 0;

			}

			// If stuck for > 1.2s, resync position to current waypoint path
			if ( d.stuckStrikes >= 3 ) {

				// Search a forward-biased WINDOW around the current index,
				// not the entire path. A full-path nearest-point search
				// can pick a point BEHIND d.idx whenever the track loops
				// back close to itself — exactly what a tight hairpin
				// does — silently teleporting the car backward and
				// undoing real progress instead of recovering it (verified
				// with a real-physics simulation: without this bound, the
				// car oscillated between the same 3-4 waypoints for 90+
				// seconds, repeatedly resynced BACKWARD each time it
				// nearly cleared the bend). A small backward allowance
				// (-2) still lets it correct minor overshoot.
				let bestJ = d.idx, bestD = Infinity;
				for ( let step = - 2; step <= 10; step ++ ) {

					const j = ( ( d.idx + step ) % path.length + path.length ) % path.length;
					const dx = path[ j ].x - d.vehicle.spherePos.x;
					const dz = path[ j ].z - d.vehicle.spherePos.z;
					const distSq = dx * dx + dz * dz;
					if ( distSq < bestD ) {

						bestD = distSq;
						bestJ = j;

					}

				}

				// This resync can move d.idx across the lap-boundary (index
				// 0) in EITHER direction without going through either of
				// the normal forward-progress lap-counting checks in
				// section 2 below (both of those only ever move d.idx
				// forward by a bounded amount — this search is
				// bidirectional, -2..+10). A forward jump across the
				// boundary would silently skip counting a completed lap
				// (the AI would then need an extra real lap to reach
				// TOTAL_RACE_LAPS — never a problem noticed as "stops
				// too early"). A BACKWARD jump across the boundary is the
				// one that causes exactly that symptom: it silently
				// un-crosses a lap that was already counted, and when the
				// car naturally re-crosses forward again minutes later —
				// re-driving what is physically only the last stretch
				// before the finish line, not a genuine extra lap — the
				// normal forward check counts it AGAIN, so lapsCompleted
				// reaches TOTAL_RACE_LAPS one real lap early. This can
				// happen for real: the stuck/circling recovery above is
				// most likely to trigger right where the track is
				// hardest to drive, and a hairpin or tight chicane right
				// after the start/finish line is a common example.
				// Detected the same way the forward checks above detect a
				// crossing (comparing raw index order), just for
				// whichever direction this jump actually went, and
				// applied here so d.lapsCompleted stays correct no matter
				// which of the two places moved d.idx last.
				const oldIdx = d.idx;
				const pathLen = path.length;
				const fwdJumpDist = ( bestJ - oldIdx + pathLen ) % pathLen;
				const backJumpDist = ( oldIdx - bestJ + pathLen ) % pathLen;
				if ( fwdJumpDist <= backJumpDist ) {

					if ( bestJ < oldIdx && d.hasLeftStartZone ) {

						d.lapsCompleted = ( d.lapsCompleted || 0 ) + 1;
						if ( d.lapsCompleted >= TOTAL_RACE_LAPS ) {

							d.finished = true;
							d.finishTime = totalTime;

						}

					}

				} else if ( bestJ > oldIdx && d.hasLeftStartZone ) {

					d.lapsCompleted = Math.max( 0, ( d.lapsCompleted || 0 ) - 1 );

				}

				d.idx = bestJ;
				const p = path[ bestJ ];
				const pNext = path[ ( bestJ + 1 ) % path.length ];
				const heading = Math.atan2( pNext.x - p.x, pNext.z - p.z );

				const pWorld = d.vehicle.physicsWorld || ( d.vehicle.rigidBody ? d.vehicle.rigidBody.world : null );
				if ( pWorld && d.vehicle.rigidBody ) {

					rigidBody.setPosition( pWorld, d.vehicle.rigidBody, [ p.x, 0.5, p.z ], false );
					rigidBody.setLinearVelocity( pWorld, d.vehicle.rigidBody, [ 0, 0, 0 ] );
					rigidBody.setAngularVelocity( pWorld, d.vehicle.rigidBody, [ 0, 0, 0 ] );

				}

				d.vehicle.spherePos.set( p.x, 0.5, p.z );
				d.vehicle.sphereVel.set( 0, 0, 0 );
				d.vehicle.container.position.set( p.x, 0, p.z );
				d.vehicle.container.rotation.set( 0, heading, 0 );
				d.vehicle.linearSpeed = 0;
				d.stuckStrikes = 0;
				d.sampleTimer = 0;

				// Re-teleporting alone isn't enough: the normal 3-waypoint
				// lookahead is what got the car into this trap in the
				// first place — at a tight bend it can point to a target
				// that's nearly BEHIND the car, driving the steering into
				// a sustained one-directional spin (a real circular limit
				// cycle, verified with a real-physics single-car
				// simulation — no other vehicles involved). Force a window
				// of single-waypoint-ahead pursuit (see section 3 below)
				// so the car is guaranteed to be chasing a point that is
				// actually in front of it until it physically clears the
				// corner, before handing back to normal lookahead pursuit.
				//
				// This window is bounded by ACTUAL PROGRESS (d.idx must
				// reach bestJ+2), not a fixed timer: a flat 2s timeout
				// verified NOT to be enough at every corner — the car can
				// still be mid-corner (idx unchanged) when the timer
				// expires, snap back to the long lookahead while badly
				// misaligned, and re-diverge into the exact same trap
				// forever. A 6s wall-clock cap still guards against a
				// pathological case where the car can't reach even the
				// nearby recovery target at all.
				d.recoveryTargetIdx = ( bestJ + 2 ) % path.length;
				d.recoveryDeadline = totalTime + 6.0;

			}

			// 2. Waypoint Progression Search
			let bestWindowIdx = d.idx;
			let minWindowDist = Infinity;
			for ( let step = 0; step <= 8; step ++ ) {

				const testIdx = ( d.idx + step ) % path.length;
				const pt = path[ testIdx ];
				const distSq = ( pt.x - d.vehicle.spherePos.x ) ** 2 + ( pt.z - d.vehicle.spherePos.z ) ** 2;
				if ( distSq < minWindowDist ) {

					minWindowDist = distSq;
					bestWindowIdx = testIdx;

				}

			}

			if ( bestWindowIdx !== d.idx ) {

				if ( bestWindowIdx < d.idx && d.hasLeftStartZone ) {

					d.lapsCompleted = ( d.lapsCompleted || 0 ) + 1;
					if ( d.lapsCompleted >= TOTAL_RACE_LAPS ) {

						d.finished = true;
						d.finishTime = totalTime;

					}

				}
				d.idx = bestWindowIdx;

			} else {

				const curPt = path[ ( d.idx + 1 ) % path.length ];
				const dToCur = Math.hypot( curPt.x - d.vehicle.spherePos.x, curPt.z - d.vehicle.spherePos.z );

				// Forward-crossing check: even when the car is pushed
				// laterally off the racing line — mid-corner, avoiding
				// another vehicle, or just carrying speed wide — if it
				// has already passed BEYOND this waypoint along the
				// track's direction of travel, treat it as reached. A
				// pure distance threshold alone can permanently freeze
				// index progression at a tight corner: verified with a
				// real-physics single-car simulation (no other vehicles
				// involved at all) — the car's pursuit-induced arc stayed
				// juuust outside the 2.0-unit distance threshold of the
				// next waypoint on every pass, so d.idx never advanced,
				// the lookahead target never updated, and the car circled
				// the same spot indefinitely (30+ seconds, no recovery).
				const segAfter = path[ ( d.idx + 2 ) % path.length ];
				const segX = segAfter.x - curPt.x, segZ = segAfter.z - curPt.z;
				const segLen = Math.hypot( segX, segZ ) || 1;
				const toCarX = d.vehicle.spherePos.x - curPt.x, toCarZ = d.vehicle.spherePos.z - curPt.z;
				const forwardProgress = ( toCarX * segX + toCarZ * segZ ) / segLen;

				if ( dToCur < 2.0 || forwardProgress > 0.5 ) {

					d.idx = ( d.idx + 1 ) % path.length;
					if ( d.idx === 0 && d.hasLeftStartZone ) {

						d.lapsCompleted = ( d.lapsCompleted || 0 ) + 1;
						if ( d.lapsCompleted >= TOTAL_RACE_LAPS ) {

							d.finished = true;
							d.finishTime = totalTime;

						}

					}

				}

			}

			// 3. Target Waypoint & Lateral Offset (Personal Racing Line)
			const lineOffset = ( d.lineOffset !== undefined ) ? d.lineOffset : ( ( driverIdx % 3 ) - 1 ) * 0.5;
			d.lineOffset = lineOffset;

			// Recovery mode: right after a stuck-resync, use a 1-waypoint
			// lookahead with no lateral offset instead of the normal
			// LOOKAHEAD_BASE=3 + racing-line offset. A far lookahead is
			// what causes the circling trap this recovers from (see the
			// comment above d.recoveryTargetIdx's assignment); the
			// immediate next waypoint is always geometrically close, so
			// it keeps the pursuit target in front of the car while it
			// clears the corner. Active until the car has actually
			// advanced past d.recoveryTargetIdx (isIndexBehind null/false
			// means "reached or passed it"), or the wall-clock safety cap
			// expires — whichever first — then normal pursuit resumes.
			const inRecovery = d.recoveryTargetIdx !== undefined &&
				isIndexBehind( d.idx, d.recoveryTargetIdx, path.length ) === true &&
				totalTime < ( d.recoveryDeadline || 0 );
			if ( ! inRecovery ) {

				d.recoveryTargetIdx = undefined;

			}

			const effectiveLookahead = inRecovery ? 1 : LOOKAHEAD_BASE;
			const effectiveLineOffset = inRecovery ? 0 : lineOffset;

			const targetIdx = ( d.idx + effectiveLookahead ) % path.length;
			const targetPt = path[ targetIdx ];

			// Compute forward vector & perpendicular for racing line offset
			const nextPt = path[ ( targetIdx + 1 ) % path.length ];
			const fwdX = nextPt.x - targetPt.x;
			const fwdZ = nextPt.z - targetPt.z;
			const fwdLen = Math.hypot( fwdX, fwdZ ) || 1;
			const perpX = - fwdZ / fwdLen;
			const perpZ = fwdX / fwdLen;

			const targetX = targetPt.x + perpX * effectiveLineOffset;
			const targetZ = targetPt.z + perpZ * effectiveLineOffset;

			const dx = targetX - d.vehicle.spherePos.x;
			const dz = targetZ - d.vehicle.spherePos.z;

			// 4. Pure Pursuit Steering
			const carAngle = getHeadingY( d.vehicle );
			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - carAngle;
			angleDiff = normalizeAngle( angleDiff );

			// Collision avoidance / Overtaking offset
			//
			// Only reacts to vehicles roughly AHEAD (checked via aheadDot
			// below) and eases off the throttle near them (avoidSlowdown)
			// instead of just steering harder at full speed. On its own
			// this ahead-only + slowdown behaviour is NOT enough though:
			// two AI cars (or an AI car and a stopped one) meeting at a
			// corner can still both react identically and steer away from
			// each other by the same amount forever — a symmetric deadlock
			// that never resolves because neither avoidance response is
			// ever allowed to "win". Verified with a real-physics, real-
			// Vehicle/real-updateRaceAIDrivers simulation: a stationary
			// obstacle parked mid-corner produced 15-24s standoffs with
			// only the ahead-only+slowdown behaviour.
			//
			// Fix: add a priority rule. AI always fully yields sideways to
			// the player (playerVehicle, below). Between two AI drivers,
			// only the one BEHIND on the racing line (by path index,
			// wraparound-aware via isIndexBehind) steers to avoid — the
			// leading car holds its line. Both cars still get the
			// proximity slowdown regardless, so the trailing car isn't
			// left steering at full speed into the back of the leader.
			let avoidSteer = 0;
			let avoidSlowdown = 1.0;
			const carFwdX = Math.sin( carAngle ), carFwdZ = Math.cos( carAngle );
			const checkVehicles = [];
			if ( playerVehicle ) checkVehicles.push( { vehicle: playerVehicle, idx: null, oIdx: - 1 } );
			drivers.forEach( ( otherD, oIdx ) => {

				if ( oIdx !== driverIdx ) checkVehicles.push( { vehicle: otherD.vehicle, idx: otherD.idx, oIdx } );

			} );

			for ( const other of checkVehicles ) {

				const otherVeh = other.vehicle;
				const odx = otherVeh.spherePos.x - d.vehicle.spherePos.x;
				const odz = otherVeh.spherePos.z - d.vehicle.spherePos.z;
				const odist = Math.hypot( odx, odz );
				if ( odist > 0.1 && odist < 2.5 ) {

					// Behind/beside — not a collision risk in the direction
					// of travel, so don't react (this alone is what let two
					// cars symmetrically dodge each other at a corner
					// without ever fully passing).
					const aheadDot = ( odx * carFwdX + odz * carFwdZ ) / odist;
					if ( aheadDot < 0.2 ) continue;

					// Always slow near a vehicle ahead, regardless of who
					// has steering priority — keeps a literal collision
					// unlikely even while the leading car holds its line.
					avoidSlowdown = Math.min( avoidSlowdown, THREE.MathUtils.clamp( odist / 1.5, 0.35, 1.0 ) );

					// Priority check: player => always yield. Otherwise,
					// only the trailing AI car steers; exact index ties
					// (rare) are broken by driver order so the rule stays
					// asymmetric instead of collapsing back into a tie.
					let iYield;
					if ( other.idx === null ) iYield = true;
					else {

						const behind = isIndexBehind( d.idx, other.idx, path.length );
						iYield = ( behind === null ) ? ( driverIdx > other.oIdx ) : behind;

					}

					if ( ! iYield ) continue;

					// Nudge away laterally
					const sideAngle = Math.atan2( odx, odz ) - carAngle;
					const normalizedSide = normalizeAngle( sideAngle );
					const strength = ( 2.5 - odist ) * 0.25;
					if ( normalizedSide > 0 ) avoidSteer -= strength;
					else avoidSteer += strength;

				}

			}

			// NOTE on the leading minus sign: Vehicle.js's keyboard/gamepad
			// steering branch (the one AI input goes through, since AI never
			// sets touchActive) applies `targetAngular = -inputX * grip *
			// turnMultiplier * direction`, i.e. POSITIVE input.x steers the
			// car's heading (container.rotation.y) DOWNWARD while driving
			// forward — the opposite of what a raw `angleDiff` (positive =
			// "heading needs to increase to face the target") naively
			// suggests. Feeding angleDiff straight into input.x therefore
			// steers away from the target — verified empirically: a closed-
			// loop simulation of this exact formula pair diverges from a
			// fixed target (never gets closer than ~10 units) without the
			// minus sign, and converges to within ~0.05 units with it. The
			// same inversion applies to avoidSteer below, which was derived
			// with the same (backwards) assumption, so both terms are
			// negated together.
			input.x = THREE.MathUtils.clamp( - ( angleDiff * 2.5 + avoidSteer ), - 1, 1 );

			// 5. Predictive Curvature Speed Control
			let maxUpcomingCurve = Math.abs( angleDiff );
			for ( let k = 1; k <= 6; k ++ ) {

				const p1 = path[ ( d.idx + k ) % path.length ];
				const p2 = path[ ( d.idx + k + 2 ) % path.length ];
				const segAngle = Math.atan2( p2.x - p1.x, p2.z - p1.z );
				let diff = segAngle - carAngle;
				diff = normalizeAngle( diff );
				if ( Math.abs( diff ) > maxUpcomingCurve ) maxUpcomingCurve = Math.abs( diff );

			}

			const sharpness = THREE.MathUtils.clamp( maxUpcomingCurve / ( Math.PI / 2.2 ), 0, 1 );
			input.z = ( 1.0 - sharpness * 0.6 ) * avoidSlowdown;

			// Drift / handbrake pulse on sharp turns
			if ( sharpness > 0.75 && Math.abs( d.vehicle.linearSpeed ) > 5 ) {

				input.handbrake = true;

			}

		}

		d.vehicle.update( dt, input );

	} );

}

/**
 * Free-Roam / Hajwalah AI Update ("هجولة وتفحيط احترافي")
 * Features multi-state AI (CRUISING, DRIFTING, DONUTS, WALL_AVOIDANCE).
 */
export function updateFreeRoamAIDrivers( drivers, dt, roadHalf, roadHalfZ = roadHalf ) {

	// Widened after feedback that the AI stayed clustered in the middle of
	// the arena instead of using the whole floor — wanderRadius is the
	// radius random targets are picked within (was 0.45, leaving over
	// half the arena's radius, and nearly all 4 corners, completely
	// unused); wallLimitRadius is where the AVOIDANCE safety state kicks
	// in (was 0.65) and needs to stay comfortably above wanderRadius so
	// normal wandering doesn't constantly trip the wall-avoidance check.
	// Now per-axis (X from roadHalf, Z from the new optional roadHalfZ,
	// defaulting to roadHalf for backward-compatible square arenas) so a
	// rectangular arena's AI wander area matches its actual footprint
	// instead of a circle inscribed inside the shorter side.
	const wanderRadiusX = roadHalf * 0.8;
	const wanderRadiusZ = roadHalfZ * 0.8;
	const wallLimitRadiusX = roadHalf * 0.92;
	const wallLimitRadiusZ = roadHalfZ * 0.92;

	drivers.forEach( ( d ) => {

		// Initialize state machine if absent
		if ( ! d.aiState ) {

			d.aiState = 'CRUISING'; // CRUISING | DRIFTING | DONUT | AVOIDANCE
			d.stateTimer = 2 + Math.random() * 3;
			d.donutCenter = { x: 0, z: 0 };
			d.donutAngle = 0;

		}

		// 1. Stuck Watchdog
		d.sampleTimer = ( d.sampleTimer || 0 ) + dt;
		if ( d.sampleTimer >= 0.5 ) {

			d.sampleTimer = 0;
			const moved = Math.hypot(
				d.vehicle.spherePos.x - ( d.samplePos ? d.samplePos.x : d.vehicle.spherePos.x ),
				d.vehicle.spherePos.z - ( d.samplePos ? d.samplePos.z : d.vehicle.spherePos.z )
			);
			d.samplePos = { x: d.vehicle.spherePos.x, z: d.vehicle.spherePos.z };

			if ( moved < 0.3 ) d.stuckStrikes = ( d.stuckStrikes || 0 ) + 1;
			else d.stuckStrikes = 0;

		}

		if ( d.stuckStrikes >= 3 ) {

			// Teleport safely back inside arena
			const a = Math.random() * Math.PI * 2;
			const r = Math.random() * 0.5;
			const px = Math.cos( a ) * wanderRadiusX * r;
			const pz = Math.sin( a ) * wanderRadiusZ * r;

			const pWorld = d.vehicle.physicsWorld || ( d.vehicle.rigidBody ? d.vehicle.rigidBody.world : null );
			if ( pWorld && d.vehicle.rigidBody ) {

				rigidBody.setPosition( pWorld, d.vehicle.rigidBody, [ px, 0.5, pz ], false );
				rigidBody.setLinearVelocity( pWorld, d.vehicle.rigidBody, [ 0, 0, 0 ] );
				rigidBody.setAngularVelocity( pWorld, d.vehicle.rigidBody, [ 0, 0, 0 ] );

			}

			d.vehicle.spherePos.set( px, 0.5, pz );
			d.vehicle.container.position.set( px, 0, pz );
			d.vehicle.linearSpeed = 0;
			d.stuckStrikes = 0;
			d.aiState = 'CRUISING';
			d.stateTimer = 2;

		}

		d.stateTimer -= dt;

		// 2. Wall / Arena Edge Safety Check — normalized "ellipse distance"
		// (each axis divided by its own radius before combining): 1.0
		// means exactly at the boundary on that axis. Plain Math.hypot(x,z)
		// against a single radius would treat a rectangular arena's long
		// axis as out-of-bounds too early (or its short axis too late).
		const distNormWall = Math.hypot( d.vehicle.spherePos.x / wallLimitRadiusX, d.vehicle.spherePos.z / wallLimitRadiusZ );
		if ( distNormWall > 1 ) {

			d.aiState = 'AVOIDANCE';
			d.target = { x: 0, z: 0 };

		}

		// 3. State Transitions
		if ( d.aiState !== 'AVOIDANCE' && d.stateTimer <= 0 ) {

			const rand = Math.random();
			if ( rand < 0.45 ) {

				d.aiState = 'DRIFTING';
				d.stateTimer = 3 + Math.random() * 4;
				const a = Math.random() * Math.PI * 2;
				const r = Math.random();
				d.target = { x: Math.cos( a ) * wanderRadiusX * r, z: Math.sin( a ) * wanderRadiusZ * r };

			} else if ( rand < 0.75 ) {

				d.aiState = 'CRUISING';
				d.stateTimer = 3 + Math.random() * 4;
				const a = Math.random() * Math.PI * 2;
				const r = Math.random();
				d.target = { x: Math.cos( a ) * wanderRadiusX * r, z: Math.sin( a ) * wanderRadiusZ * r };

			} else {

				d.aiState = 'DONUT';
				d.stateTimer = 2.5 + Math.random() * 2.5;
				d.donutCenter = { x: d.vehicle.spherePos.x, z: d.vehicle.spherePos.z };
				d.donutAngle = Math.random() * Math.PI * 2;

			}

		}

		// 4. Execute AI Behavior Based On State
		const input = { x: 0, z: 1, touchActive: false, handbrake: false };

		if ( d.aiState === 'AVOIDANCE' ) {

			const dx = - d.vehicle.spherePos.x;
			const dz = - d.vehicle.spherePos.z;
			const carAngle = getHeadingY( d.vehicle );
			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - carAngle;
			angleDiff = normalizeAngle( angleDiff );

			// See the steering-sign note in updateRaceAIDrivers() above —
			// same inversion, same fix (leading minus). This is the one
			// that most directly caused "stuck on the fence": AVOIDANCE
			// aims at the arena center but, without the minus sign, was
			// steering the car further INTO the wall instead of away from it.
			input.x = THREE.MathUtils.clamp( - angleDiff * 3.0, - 1, 1 );
			input.z = 0.8;

			const distNormWander = Math.hypot( d.vehicle.spherePos.x / wanderRadiusX, d.vehicle.spherePos.z / wanderRadiusZ );
			if ( distNormWander < 0.8 ) {

				d.aiState = 'CRUISING';
				d.stateTimer = 2;

			}

		} else if ( d.aiState === 'DONUT' ) {

			// High RPM Donut / Spin maneuver
			input.x = 1.0; // full lock
			input.z = 1.0; // full gas
			input.handbrake = ( Math.sin( Date.now() * 0.01 ) > 0.5 ); // rhythmic handbrake pulse

		} else if ( d.aiState === 'DRIFTING' ) {

			const dx = ( d.target ? d.target.x : 0 ) - d.vehicle.spherePos.x;
			const dz = ( d.target ? d.target.z : 0 ) - d.vehicle.spherePos.z;
			const carAngle = getHeadingY( d.vehicle );
			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - carAngle;
			angleDiff = normalizeAngle( angleDiff );

			// Aggressive steering + handbrake flick to initiate drift
			// See the steering-sign note in updateRaceAIDrivers() above.
			input.x = THREE.MathUtils.clamp( - angleDiff * 4.0, - 1, 1 );
			input.z = 1.0;

			if ( Math.abs( angleDiff ) > 0.4 ) {

				input.handbrake = true;

			}

		} else { // CRUISING

			const dx = ( d.target ? d.target.x : 0 ) - d.vehicle.spherePos.x;
			const dz = ( d.target ? d.target.z : 0 ) - d.vehicle.spherePos.z;
			const carAngle = getHeadingY( d.vehicle );
			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - carAngle;
			angleDiff = normalizeAngle( angleDiff );

			// See the steering-sign note in updateRaceAIDrivers() above.
			input.x = THREE.MathUtils.clamp( - angleDiff * 2.0, - 1, 1 );
			input.z = 0.85;

		}

		d.vehicle.update( dt, input );

	} );

}
