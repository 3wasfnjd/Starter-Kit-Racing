import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle, MAX_SPEED } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { DriftMarks } from './DriftMarks.js';
import { GameAudio } from './Audio.js';
import { LapTimer } from './LapTimer.js';
import { ColorMapGLTFLoader } from './Loader.js';
import { ARManager } from './ARManager.js';


const renderer = new THREE.WebGLRenderer( { antialias: true, alpha: true, outputBufferType: THREE.HalfFloatType } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( window.devicePixelRatio );
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true; // required so main.js can offer AR MODE; NORMAL mode is unaffected

const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
bloomPass.strength = 0.02;
bloomPass.radius = 0.02;
bloomPass.threshold = 0.5;

renderer.setEffects( [ bloomPass ] );

document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0xadb2ba );
scene.fog = new THREE.Fog( 0xadb2ba, 30, 55 );

const dirLight = new THREE.DirectionalLight( 0xffffff, 3 );
dirLight.position.set( 11.4, 15, -5.3 );
dirLight.castShadow = true;
dirLight.shadow.mapSize.setScalar( 4096 );
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 60;
dirLight.shadow.radius = 4;
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xc8d8e8, 0x7a8a5a, 2 );
hemiLight.position.copy( dirLight.position )
scene.add( hemiLight );


window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );

} );

const loader = new ColorMapGLTFLoader();

const modelNames = [
	'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
	'track-straight', 'track-corner', 'track-bump', 'track-finish',
	'decoration-empty', 'decoration-forest', 'decoration-tents',
];

const models = {};

async function loadModels() {

	const promises = modelNames.map( ( name ) =>
		new Promise( ( resolve, reject ) => {

			loader.load( `models/${ name }.glb`, ( gltf ) => {

				const meshes = [];
				gltf.scene.traverse( ( child ) => {

					if ( child.isMesh ) {

						child.material.side = THREE.FrontSide;
						meshes.push( child );

					}

				} );

				// Godot imports vehicle models at root_scale=0.5
				if ( name.startsWith( 'vehicle-' ) ) {

					gltf.scene.scale.setScalar( 0.5 );

				}

				if ( meshes.length === 1 ) {

					const mesh = meshes[ 0 ];
					mesh.removeFromParent();
					models[ name ] = mesh;

				} else {

					models[ name ] = gltf.scene;

				}

				resolve();

			}, undefined, reject );

		} )
	);

	await Promise.all( promises );

}

// ─── Mode selection menu ──────────────────────────────────
// Neither existing markup nor CSS is touched; this overlay is created
// entirely from main.js so index.html stays untouched too.

function createModeMenu( { arAvailable } ) {

	return new Promise( ( resolve ) => {

		const menu = document.createElement( 'div' );
		menu.style.cssText = `
			position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column;
			align-items: center; justify-content: center; gap: 16px;
			background: rgba(20,22,26,0.72); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		`;

		const title = document.createElement( 'div' );
		title.textContent = 'Choose mode';
		title.style.cssText = 'color:#fff; font-size:20px; font-weight:600; margin-bottom:8px;';
		menu.appendChild( title );

		function makeButton( label, enabled ) {

			const btn = document.createElement( 'button' );
			btn.textContent = label;
			btn.disabled = ! enabled;
			btn.style.cssText = `
				padding: 14px 32px; font-size: 16px; border-radius: 999px; border: none;
				cursor: ${ enabled ? 'pointer' : 'not-allowed' };
				background: ${ enabled ? '#15A249' : '#555' }; color: #fff; opacity: ${ enabled ? '1' : '0.6' };
			`;
			return btn;

		}

		const normalBtn = makeButton( 'NORMAL MODE', true );
		const arBtn = makeButton( arAvailable ? 'AR MODE (Meta Quest 3)' : 'AR MODE (not available on this device)', arAvailable );

		normalBtn.addEventListener( 'click', () => {

			menu.remove();
			resolve( 'normal' );

		} );

		arBtn.addEventListener( 'click', () => {

			menu.remove();
			resolve( 'ar' );

		} );

		menu.appendChild( normalBtn );
		menu.appendChild( arBtn );
		document.body.appendChild( menu );

	} );

}

// ─── Shared physics world setup (used by both modes) ──────

function createPhysicsWorld() {

	const worldSettings = createWorldSettings();
	worldSettings.gravity = [ 0, - 9.81, 0 ];

	const BPL_MOVING = addBroadphaseLayer( worldSettings );
	const BPL_STATIC = addBroadphaseLayer( worldSettings );
	const OL_MOVING = addObjectLayer( worldSettings, BPL_MOVING );
	const OL_STATIC = addObjectLayer( worldSettings, BPL_STATIC );

	enableCollision( worldSettings, OL_MOVING, OL_STATIC );
	enableCollision( worldSettings, OL_MOVING, OL_MOVING );

	const world = createWorld( worldSettings );
	world._OL_MOVING = OL_MOVING;
	world._OL_STATIC = OL_STATIC;

	return world;

}

// ─── Shared per-frame driving/game-object update, used by ──
// ─── both NORMAL and AR modes once a vehicle exists.       ──

function updateVehicleAndFx( dt, input, ctx ) {

	const { world, vehicle, particles, driftMarks, audio, lapTimer, contactListener } = ctx;

	updateWorld( world, contactListener, dt );
	vehicle.update( dt, input );

	particles.update( dt, vehicle );
	driftMarks.update( dt, vehicle );
	audio.update( dt, vehicle.linearSpeed / MAX_SPEED, input.z, vehicle.driftIntensity );

	if ( lapTimer ) {

		const hasInput = input.touchActive || Math.abs( input.x ) > 0.05 || Math.abs( input.z ) > 0.05;
		lapTimer.update( dt, vehicle.spherePos, hasInput );

	}

}

// ─── NORMAL MODE (unchanged behavior from the original game) ──

function startNormalMode( { customCells, spawn, mapParam } ) {

	// Compute track bounds and size physics/shadows to fit
	const bounds = computeTrackBounds( customCells );
	const hw = bounds.halfWidth;
	const hd = bounds.halfDepth;
	const groundSize = Math.max( hw, hd ) * 2 + 20;

	const shadowExtent = Math.max( hw, hd ) + 10;
	dirLight.shadow.camera.left = - shadowExtent;
	dirLight.shadow.camera.right = shadowExtent;
	dirLight.shadow.camera.top = shadowExtent;
	dirLight.shadow.camera.bottom = - shadowExtent;
	dirLight.shadow.camera.updateProjectionMatrix();

	scene.fog.near = groundSize * 0.4;
	scene.fog.far = groundSize * 0.8;

	buildTrack( scene, models, customCells );

	// Probes
	const probeHeight = 6;
	const probes = new LightProbeGrid(
		hw * 2, probeHeight, hd * 2,
		Math.max( 4, Math.round( hw / 4 ) ),
		2,
		Math.max( 4, Math.round( hd / 4 ) ),
	);
	probes.position.set( bounds.centerX, probeHeight / 2, bounds.centerZ );
	probes.bake( renderer, scene, { cubemapSize: 32, near: 0.1, far: groundSize } );
	scene.add( probes );

	// scene.add( new LightProbeGridHelper( probes, 0.5 ) );

	const world = createPhysicsWorld();

	buildWallColliders( world, null, customCells );

	const roadHalf = groundSize / 2;
	rigidBody.create( world, {
		shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
		motionType: MotionType.STATIC,
		objectLayer: world._OL_STATIC,
		position: [ bounds.centerX, - 0.125, bounds.centerZ ],
		friction: 5.0,
		restitution: 0.0,
	} );

	const sphereBody = createSphereBody( world, spawn ? spawn.position : null );

	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;

	if ( spawn ) {

		const [ sx, sy, sz ] = spawn.position;
		vehicle.spherePos.set( sx, sy, sz );
		vehicle.prevModelPos.set( sx, 0, sz );
		vehicle.container.rotation.y = spawn.angle;

	}

	const vehicleGroup = vehicle.init( models[ 'vehicle-truck-yellow' ] );
	scene.add( vehicleGroup );

	dirLight.target = vehicleGroup;

	const cam = new Camera();
	scene.add( cam.debug );

	const controls = new Controls();

	const particles = new SmokeTrails( scene );
	const driftMarks = new DriftMarks( scene, mapParam );

	const audio = new GameAudio();
	audio.init( cam.camera, vehicleGroup );

	const lapTimer = new LapTimer( customCells, mapParam );

	const _forward = new THREE.Vector3();
	const _camLead = new THREE.Vector3();

	const contactListener = {
		onContactAdded( bodyA, bodyB ) {

			if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

			_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
			audio.playImpact( impactVelocity );

		}
	};

	const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer, contactListener };

	return {

		frameUpdate( dt ) {

			const input = controls.update();

			updateVehicleAndFx( dt, input, ctx );

			dirLight.position.set(
				vehicle.spherePos.x + 11.4,
				15,
				vehicle.spherePos.z - 5.3
			);

			const mv = vehicle.modelVelocity;
			_camLead.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).multiplyScalar( Math.sqrt( mv.x * mv.x + mv.z * mv.z ) );
			cam.update( dt, vehicle.spherePos, _camLead );

			renderer.render( scene, cam.camera );

		}

	};

}

// ─── AR MODE (Meta Quest 3 passthrough) ────────────────────

async function startARMode( { mapParam } ) {

	const arManager = new ARManager( { renderer, scene, models } );
	const world = createPhysicsWorld();
	arManager.setWorld( world );

	const placeholderCamera = new THREE.PerspectiveCamera(); // pose is overridden by WebXR while presenting

	let gameState = null; // populated once the user confirms spawn placement
	const controls = new Controls();

	arManager.onPlaced = ( spawn ) => {

		const sphereBody = createSphereBody( world, [ spawn.position.x, spawn.position.y, spawn.position.z ] );

		const vehicle = new Vehicle();
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.copy( spawn.position );
		vehicle.prevModelPos.set( spawn.position.x, 0, spawn.position.z );
		vehicle.container.rotation.y = spawn.angle;

		// The vehicle stays a direct child of `scene` (true WebXR world
		// space), matching how physics already works in NORMAL mode.
		const vehicleGroup = vehicle.init( models[ 'vehicle-truck-yellow' ] );
		scene.add( vehicleGroup );

		dirLight.target = vehicleGroup;

		// Smoke is authored at real-meter scale (BASE_SIZE=1 in Particles.js)
		// for NORMAL mode's much larger track. In AR the car is toy-sized,
		// so shrink smoke drastically or it renders as room-filling clouds
		// — a likely cause of the GPU overdraw/lag reported during drifting.
		const particles = new SmokeTrails( scene, 0.12 );
		const driftMarks = new DriftMarks( scene, mapParam || 'ar-freeroam' );

		const audio = new GameAudio();
		audio.init( renderer.xr.getCamera(), vehicleGroup ); // XR camera rig instead of the NORMAL-mode chase Camera

		const _forward = new THREE.Vector3();

		const contactListener = {
			onContactAdded( bodyA, bodyB ) {

				if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

				_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
				_forward.y = 0;
				_forward.normalize();

				const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
				audio.playImpact( impactVelocity );

			}
		};

		// No lapTimer — free-roam has no track/laps.
		gameState = { vehicle, vehicleGroup, vehicleScale: 1, particles, driftMarks, audio, contactListener };

	};

	const xrSession = await arManager.requestSession();

	// Custom post-processing (bloom) is authored for a single flat camera
	// and is not guaranteed to handle WebXR's per-eye ArrayCamera stereo
	// rendering correctly — a mismatch here is a known cause of content
	// appearing to lag/swim with head movement. Disable while presenting.
	renderer.setEffects( [] );
	xrSession.addEventListener( 'end', () => {

		renderer.setEffects( [ bloomPass ] );

	} );

	return {

		frameUpdate( dt, timestamp, frame ) {

			try {

				arManager.update( frame, dt );

				if ( gameState ) {

					// Controllers drive the car once the track is locked in;
					// keyboard/gamepad still work too (e.g. testing on desktop).
					const kbInput = controls.update();
					const arInput = arManager.getDriveInput();
					const input = {
						x: Math.abs( arInput.x ) > Math.abs( kbInput.x ) ? arInput.x : kbInput.x,
						z: Math.abs( arInput.z ) > Math.abs( kbInput.z ) ? arInput.z : kbInput.z,
						touchActive: kbInput.touchActive,
					};

					updateVehicleAndFx( dt, input, { world, ...gameState } );

					const scaleInput = arManager.getScaleAdjustInput();
					if ( scaleInput !== 0 ) {

						gameState.vehicleScale = THREE.MathUtils.clamp(
							gameState.vehicleScale * ( 1 - scaleInput * 0.8 * dt ),
							0.25, 3.0
						);
						gameState.vehicleGroup.scale.setScalar( gameState.vehicleScale );

					}

					dirLight.position.set(
						gameState.vehicle.spherePos.x + 11.4,
						15,
						gameState.vehicle.spherePos.z - 5.3
					);

				} else {

					// Placement phase: still step physics so nothing is stale
					// once the vehicle spawns, but there is no vehicle yet.
					updateWorld( world, null, dt );

				}

			} catch ( e ) {

				console.error( '[main] AR frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

// ─── Shared animate loop ───────────────────────────────────

let activeMode = null;
const timer = new THREE.Timer();

function animate( timestamp, frame ) {

	timer.update( timestamp );
	const dt = Math.min( timer.getDelta(), 1 / 30 );

	if ( activeMode ) activeMode.frameUpdate( dt, timestamp, frame );

}

renderer.setAnimationLoop( animate );

function showErrorOverlay( message, stack, onRetry ) {

	const box = document.createElement( 'div' );
	box.style.cssText = `
		position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 16px; padding: 24px; text-align: center;
		background: rgba(20,22,26,0.92); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
	`;

	const title = document.createElement( 'div' );
	title.textContent = 'AR MODE failed to start';
	title.style.cssText = 'color:#fff; font-size:18px; font-weight:600;';

	const detail = document.createElement( 'div' );
	detail.textContent = message;
	detail.style.cssText = 'color:#ddd; font-size:14px; max-width:640px; white-space:pre-wrap;';

	const stackBox = document.createElement( 'div' );
	stackBox.textContent = stack ? stack.split( '\n' ).slice( 0, 6 ).join( '\n' ) : '';
	stackBox.style.cssText = 'color:#999; font-size:11px; max-width:640px; white-space:pre-wrap; text-align:left; font-family:monospace;';

	const retryBtn = document.createElement( 'button' );
	retryBtn.textContent = 'Back to menu';
	retryBtn.style.cssText = `
		padding: 12px 28px; font-size: 15px; border-radius: 999px; border: none;
		cursor: pointer; background: #15A249; color: #fff;
	`;
	retryBtn.addEventListener( 'click', () => {

		box.remove();
		onRetry();

	} );

	box.appendChild( title );
	box.appendChild( detail );
	box.appendChild( stackBox );
	box.appendChild( retryBtn );
	document.body.appendChild( box );

	console.error( 'AR MODE failed:', message, stack );

}

async function init() {

	registerAll();
	await loadModels();

	const mapParam = new URLSearchParams( window.location.search ).get( 'map' );
	let customCells = null;
	let spawn = null;

	if ( mapParam ) {

		try {

			customCells = decodeCells( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

		}

	}

	const arAvailable = await ARManager.isSupported();

	// eslint-disable-next-line no-constant-condition
	while ( true ) {

		const choice = await createModeMenu( { arAvailable } );

		if ( choice === 'ar' ) {

			try {

				activeMode = await startARMode( { mapParam } );
				break;

			} catch ( e ) {

				activeMode = null;

				await new Promise( ( resolve ) => {

					showErrorOverlay(
						( e && e.message ) ? e.message : String( e ),
						e && e.stack ? e.stack : '',
						resolve
					);

				} );
				continue; // back to the mode menu instead of a silent black screen

			}

		} else {

			activeMode = startNormalMode( { customCells, spawn, mapParam } );
			break;

		}

	}

}

init();
