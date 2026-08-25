import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, cylinder, MotionType } from 'crashcat';
import { Vehicle, MAX_SPEED } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, computeTrackPath, NPC_TRUCKS, TRACK_CELLS, GRID_SCALE } from './Track.js';
import { updateRaceAIDrivers, updateFreeRoamAIDrivers } from './AIController.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { DriftMarks } from './DriftMarks.js';
import { GameAudio } from './Audio.js';
import { createFlag, createSaudiFlagDataUrl } from './Flag.js';
import { LapTimer } from './LapTimer.js';
import { ColorMapGLTFLoader } from './Loader.js';
import { ARManager } from './ARManager.js';
import { PlaceableObject } from './PlaceableObject.js';
import { Radio } from './Radio.js';


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

// Background menu/ambient music — plays quietly from the moment the
// person picks a mode, until they turn on the in-car radio themselves
// (at which point it stops for good, handing off to the radio). No
// dedicated ambient track exists to draw from, so this reuses one of
// the existing radio tracks at low volume rather than nothing at all.
const bgMusic = new Audio( 'audio/radio/radio-1.mp3' );
bgMusic.loop = true;
bgMusic.volume = 0.25;
let bgMusicStopped = false;
function startBgMusic() {

	if ( bgMusicStopped ) return;
	bgMusic.play().catch( ( e ) => console.warn( '[main] background music autoplay blocked:', e ) );

}
function stopBgMusic() {

	bgMusicStopped = true;
	bgMusic.pause();

}
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

// Requests fullscreen on the whole page. Must be called synchronously
// inside a user-gesture handler (click) or the browser will silently
// refuse. Not all mobile browsers support this (notably iPhone Safari
// does not support Element.requestFullscreen at all) — fails silently
// there, the game still works fine, just not edge-to-edge.
function requestFullscreenSafe() {

	const el = document.documentElement;
	const request = el.requestFullscreen || el.webkitRequestFullscreen ||
		el.mozRequestFullScreen || el.msRequestFullscreen;

	if ( ! request ) return;

	try {

		const result = request.call( el );
		if ( result && result.catch ) result.catch( ( e ) => console.warn( 'Fullscreen request failed:', e ) );

	} catch ( e ) {

		console.warn( 'Fullscreen request failed:', e );

	}

}

function isFullscreenActive() {

	return !! ( document.fullscreenElement || document.webkitFullscreenElement ||
		document.mozFullScreenElement || document.msFullscreenElement );

}

function exitFullscreenSafe() {

	const exit = document.exitFullscreen || document.webkitExitFullscreen ||
		document.mozCancelFullScreen || document.msExitFullscreen;

	if ( ! exit ) return;

	try {

		const result = exit.call( document );
		if ( result && result.catch ) result.catch( ( e ) => console.warn( 'Fullscreen exit failed:', e ) );

	} catch ( e ) {

		console.warn( 'Fullscreen exit failed:', e );

	}

}

// Arms fullscreen to fire on the very first tap/click ANYWHERE on the
// page — as close to "fullscreen the instant the game opens" as a
// website is actually allowed to get. No browser permits requesting
// fullscreen with zero user interaction at all (a hard, universal
// security rule — every site is bound by it, not something specific to
// this game); the first genuine gesture is the earliest legal moment.
// Runs once, then removes itself — except it deliberately skips a tap on
// the AR entry button, since requestSession() there needs that exact
// click's own transient user-activation (see the comment on
// arEntryBtn's own listener below) and requesting fullscreen first would
// consume it and silently break entering AR. Fullscreen is moot for AR
// anyway — the XR session already takes over the whole display. If the
// very first tap happens to land on that button, this just waits for the
// next one instead of firing.
function armAutoFullscreen() {

	function trigger( e ) {

		if ( e.target.closest && e.target.closest( '.hw-ar-entry-btn' ) ) return;

		document.removeEventListener( 'pointerdown', trigger );
		requestFullscreenSafe();

	}

	document.addEventListener( 'pointerdown', trigger );

}

armAutoFullscreen();

function createModeMenu( { arAvailable } ) {

	return new Promise( ( resolve ) => {

		const style = document.createElement( 'style' );
		style.textContent = `
			#hajwalah-menu * { box-sizing: border-box; }
			#hajwalah-menu {
				position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
				background: radial-gradient(circle at 50% 20%, #1a1030 0%, #0a0a12 55%, #050508 100%);
				font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 24px 16px; overflow-y: auto;
			}
			#hajwalah-menu .hw-wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; max-width: 420px; width: 100%; }
			#hajwalah-menu .hw-logo { width: 120px; height: 120px; border-radius: 20px; filter: drop-shadow(0 0 22px rgba(139,95,191,0.55)); }
			#hajwalah-menu .hw-title {
				font-size: 32px; font-weight: 800; text-align: center; letter-spacing: 1px;
				background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
				-webkit-background-clip: text; background-clip: text; color: transparent;
				margin: 4px 0 0;
			}
			#hajwalah-menu .hw-subtitle { color: #9a94b0; font-size: 12px; letter-spacing: 2px; margin-bottom: 6px; }
			#hajwalah-menu .hw-panel {
				width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(139,95,191,0.35);
				border-radius: 18px; padding: 20px; display: flex; flex-direction: column; gap: 14px;
				backdrop-filter: blur(10px);
			}
			#hajwalah-menu .hw-field-label { color: #b9b3cc; font-size: 12.5px; text-align: center; margin-bottom: 8px; }
			#hajwalah-menu input[type=text] {
				padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12);
				background: rgba(255,255,255,0.06); color: #fff; font-size: 15px; text-align: center; width: 100%; outline: none;
			}
			#hajwalah-menu .hw-swatches { display: flex; gap: 10px; justify-content: center; }
			#hajwalah-menu .hw-swatch {
				width: 60px; height: 60px; border-radius: 12px; cursor: pointer; padding: 0;
				border: 2px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05);
				display: flex; align-items: center; justify-content: center; overflow: hidden;
			}
			#hajwalah-menu .hw-swatch img { width: 90%; height: 90%; object-fit: contain; }
			#hajwalah-menu .hw-swatch.selected { border-color: #5B8CFF; box-shadow: 0 0 14px rgba(91,140,255,0.55); }
			#hajwalah-menu .hw-flag-row { display: flex; align-items: center; gap: 12px; justify-content: center; }
			#hajwalah-menu .hw-flag-pick {
				display: flex; align-items: center; justify-content: center; gap: 8px;
				padding: 10px 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14);
				background: rgba(255,255,255,0.06); color: #cfc9e0; font-size: 13px; cursor: pointer;
			}
			#hajwalah-menu .hw-flag-pick:active { background: rgba(255,255,255,0.12); }
			#hajwalah-menu .hw-flag-preview {
				width: 44px; height: 44px; border-radius: 8px; object-fit: cover;
				border: 1px solid rgba(255,255,255,0.18); display: none;
			}
			#hajwalah-menu .hw-flag-preview.shown { display: block; }
			#hajwalah-menu .hw-flag-clear {
				display: none; color: #ff8a8a; font-size: 12px; background: none; border: none; cursor: pointer;
			}
			#hajwalah-menu .hw-flag-clear.shown { display: inline-block; }
			#hajwalah-menu .hw-checkbox-row { display: flex; align-items: center; gap: 10px; color: #cfc9e0; font-size: 13.5px; justify-content: center; cursor: pointer; }
			#hajwalah-menu .hw-checkbox-row input { width: 20px; height: 20px; accent-color: #8B5FBF; }
			#hajwalah-menu .hw-mode-row { display: flex; gap: 12px; }
			#hajwalah-menu .hw-mode-card {
				flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px;
				padding: 16px 10px; border-radius: 14px; cursor: pointer; border: none;
				border: 1.5px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.05); color: #fff;
			}
			#hajwalah-menu .hw-mode-card.primary {
				border-color: rgba(91,140,255,0.7);
				background: linear-gradient(160deg, rgba(139,95,191,0.28), rgba(91,140,255,0.14));
				box-shadow: 0 4px 22px rgba(91,140,255,0.25);
			}
			#hajwalah-menu .hw-mode-card:disabled { opacity: 0.45; cursor: not-allowed; }
			#hajwalah-menu .hw-mode-card svg { width: 40px; height: 40px; }
			#hajwalah-menu .hw-mode-label { font-size: 13.5px; font-weight: 600; text-align: center; }
			#hajwalah-menu .hw-mode-sub { font-size: 10.5px; color: #a79fc4; text-align: center; }
			#hajwalah-menu .hw-back-link {
				color: #a79fc4; text-decoration: none; font-size: 12px; text-align: center; cursor: pointer; margin-top: -4px;
			}
			#hajwalah-menu .hw-step { display: flex; flex-direction: column; gap: 12px; }
			#hajwalah-menu .hw-step.hidden { display: none; }
			#hajwalah-menu .hw-footer { margin-top: 6px; color: #6b6680; font-size: 11.5px; text-align: center; letter-spacing: 0.5px; }
			#hajwalah-menu .hw-footer b { color: #9d8fd4; }
			#hajwalah-menu .hw-features-link {
				color: #5B8CFF; text-decoration: none; font-size: 12px; display: inline-block; margin-top: 4px;
			}
			#hajwalah-menu .hw-features-link:hover { text-decoration: underline; }
		`;

		const menu = document.createElement( 'div' );
		menu.id = 'hajwalah-menu';
		menu.dir = 'rtl';

		const VEHICLE_OPTIONS = [
			{ key: 'vehicle-truck-purple', label: 'أسود', thumb: 'images/menu/thumb-black.png' },
			{ key: 'vehicle-truck-red', label: 'أحمر', thumb: 'images/menu/thumb-red.png' },
			{ key: 'vehicle-truck-yellow', label: 'أصفر', thumb: 'images/menu/thumb-yellow.png' },
			{ key: 'vehicle-truck-green', label: 'رملي', thumb: 'images/menu/thumb-green.png' },
		];
		let selectedVehicle = VEHICLE_OPTIONS[ 0 ].key;
		const vehicleSwatches = [];

		function refreshSwatchSelection() {

			vehicleSwatches.forEach( ( sw ) => {

				sw.classList.toggle( 'selected', sw.dataset.key === selectedVehicle );

			} );

		}

		menu.innerHTML = `
			<div class="hw-wrap">
				<img class="hw-logo" src="images/menu/logo.png" alt="Aboden Games" />
				<div class="hw-title">هجولة عتابة</div>
				<div class="hw-subtitle">HAJWALAH &middot; AR RACING</div>
				<div class="hw-panel">
					<div>
						<div class="hw-field-label">نص مخصص (الزجاج الأمامي والباب الخلفي) — اختياري</div>
						<input type="text" class="hw-text-input" maxlength="12" placeholder="مثال: سباق" />
					</div>
					<div>
						<div class="hw-field-label">لون السيارة</div>
						<div class="hw-swatches"></div>
					</div>
					<div>
						<div class="hw-field-label">صورة العلم الخلفي — اختياري</div>
						<div class="hw-flag-row">
							<label class="hw-flag-pick">
								📷 اختر صورة
								<input type="file" accept="image/*" class="hw-flag-input" hidden />
							</label>
							<img class="hw-flag-preview" />
							<button type="button" class="hw-flag-clear">إزالة</button>
						</div>
					</div>
					<div class="hw-step hw-step-top">
						<div class="hw-mode-row">
							<button class="hw-mode-card primary hw-web-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#5B8CFF" stroke-width="1.6">
									<rect x="2.5" y="4.5" width="19" height="13" rx="2"/>
									<path d="M8 21h8M12 17.5v3.5"/>
								</svg>
								<div class="hw-mode-label">وضع الويب</div>
								<div class="hw-mode-sub">أيفون / كمبيوتر</div>
							</button>
							<button class="hw-mode-card hw-ar-entry-btn" ${ arAvailable ? '' : 'disabled' }>
								<svg viewBox="0 0 24 24" fill="none" stroke="#cfc9e0" stroke-width="1.6">
									<rect x="2.5" y="8" width="19" height="9" rx="3.5"/>
									<circle cx="8.3" cy="12.5" r="1.9"/>
									<circle cx="15.7" cy="12.5" r="1.9"/>
									<path d="M9.8 12.5h4.4"/>
									<path d="M6 8c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4"/>
								</svg>
								<div class="hw-mode-label">وضع AR</div>
								<div class="hw-mode-sub">${ arAvailable ? 'Meta Quest 3' : 'غير متاح على هذا الجهاز' }</div>
							</button>
						</div>
					</div>

					<div class="hw-step hw-step-web hidden">
						<div class="hw-mode-row">
							<button class="hw-mode-card primary hw-web-track-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#5B8CFF" stroke-width="1.6">
									<circle cx="12" cy="12" r="9"/>
									<circle cx="12" cy="12" r="2.4" fill="#5B8CFF" stroke="none"/>
									<path d="M12 5v4.6M6.2 15.5l3.6-2.2M17.8 15.5l-3.6-2.2"/>
								</svg>
								<div class="hw-mode-label">المضمار</div>
								<div class="hw-mode-sub">سباق كلاسيكي</div>
							</button>
							<button class="hw-mode-card hw-web-free-btn">
								<svg viewBox="0 0 24 24" fill="none" stroke="#cfc9e0" stroke-width="1.6">
									<path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6" />
								</svg>
								<div class="hw-mode-label">الوضع الحر</div>
								<div class="hw-mode-sub">تحكم حر بدون مضمار</div>
							</button>
						</div>
						<a href="#" class="hw-back-link-web">‹ رجوع</a>
					</div>
				</div>
				<div class="hw-footer">
					<b>ABODEN GAMES</b> &nbsp;&middot;&nbsp; &copy; 2026 &nbsp;&middot;&nbsp; جميع الحقوق محفوظة
					<br/><a href="#" class="hw-features-link">✨ عن اللعبة</a>
				</div>
			</div>
		`;

		document.head.appendChild( style );

		const swatchRow = menu.querySelector( '.hw-swatches' );
		VEHICLE_OPTIONS.forEach( ( opt ) => {

			const sw = document.createElement( 'button' );
			sw.className = 'hw-swatch';
			sw.dataset.key = opt.key;
			sw.title = opt.label;
			sw.innerHTML = `<img src="${ opt.thumb }" alt="${ opt.label }" />`;
			sw.addEventListener( 'click', () => {

				selectedVehicle = opt.key;
				refreshSwatchSelection();

			} );
			vehicleSwatches.push( sw );
			swatchRow.appendChild( sw );

		} );
		refreshSwatchSelection();

		// Flag image: read locally as a data URL via FileReader — no
		// server/upload involved, works fully offline, and the resulting
		// data: URL is exactly what THREE.TextureLoader/createFlag()
		// already accepts as an imageUrl.
		let flagImageDataUrl = null;
		const flagInput = menu.querySelector( '.hw-flag-input' );
		const flagPreview = menu.querySelector( '.hw-flag-preview' );
		const flagClear = menu.querySelector( '.hw-flag-clear' );

		flagInput.addEventListener( 'change', () => {

			const file = flagInput.files && flagInput.files[ 0 ];
			if ( ! file ) return;

			const reader = new FileReader();
			reader.onload = () => {

				flagImageDataUrl = reader.result;
				flagPreview.src = flagImageDataUrl;
				flagPreview.classList.add( 'shown' );
				flagClear.classList.add( 'shown' );

			};
			reader.readAsDataURL( file );

		} );

		flagClear.addEventListener( 'click', () => {

			flagImageDataUrl = null;
			flagInput.value = '';
			flagPreview.classList.remove( 'shown' );
			flagClear.classList.remove( 'shown' );

		} );

		const textInput = menu.querySelector( '.hw-text-input' );
		const webBtn = menu.querySelector( '.hw-web-btn' );
		const arEntryBtn = menu.querySelector( '.hw-ar-entry-btn' );
		const stepTop = menu.querySelector( '.hw-step-top' );
		const stepWeb = menu.querySelector( '.hw-step-web' );
		const webTrackBtn = menu.querySelector( '.hw-web-track-btn' );
		const webFreeBtn = menu.querySelector( '.hw-web-free-btn' );
		const backLinkWeb = menu.querySelector( '.hw-back-link-web' );

		webBtn.addEventListener( 'click', () => {

			stepTop.classList.add( 'hidden' );
			stepWeb.classList.remove( 'hidden' );

		} );

		backLinkWeb.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			stepWeb.classList.add( 'hidden' );
			stepTop.classList.remove( 'hidden' );

		} );

		function chooseWeb( freeRoam ) {

			requestFullscreenSafe();
			startBgMusic();
			menu.remove();
			resolve( { choice: 'normal', customText: textInput.value.trim(), freeRoam, vehicleKey: selectedVehicle, flagImage: flagImageDataUrl } );

		}

		webTrackBtn.addEventListener( 'click', () => chooseWeb( false ) );
		webFreeBtn.addEventListener( 'click', () => chooseWeb( true ) );

		// AR now goes straight into the session — which of the three AR
		// experiences (room-drive / floating track / floating arena) is
		// chosen from a floating 3D menu inside the headset itself
		// instead of a flat pre-session screen. hit-test is requested
		// up front for all three even though only room-drive currently
		// uses it, since the person hasn't picked a mode yet at this
		// point and re-requesting a session with different features
		// after the fact isn't practical.
		arEntryBtn.addEventListener( 'click', () => {

			if ( arEntryBtn.disabled ) return;

			// No requestFullscreenSafe() here on purpose: it would consume
			// the click's transient user-activation, and requestSession()
			// below needs that same activation. AR sessions take over the
			// whole display anyway, so it's moot.
			//
			// requestSession() itself is also started HERE, synchronously,
			// rather than later inside startARWithFloatingMenu() — some
			// browsers only honor user-activation for a call made directly
			// in the event handler, not after several chained await hops.
			// The resulting promise is handed off and awaited downstream.
			const sessionPromise = navigator.xr.requestSession( 'immersive-ar', {
				requiredFeatures: [ 'local-floor', 'hit-test' ],
				optionalFeatures: [ 'plane-detection', 'mesh-detection' ],
			} );
			startBgMusic();

			menu.remove();
			resolve( {
				choice: 'ar', customText: textInput.value.trim(),
				vehicleKey: selectedVehicle, flagImage: flagImageDataUrl, sessionPromise,
			} );

		} );

		const featuresLink = menu.querySelector( '.hw-features-link' );
		featuresLink.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			showFeaturesModal();

		} );

		document.body.appendChild( menu );

		// Background music starts on the very first interaction with the
		// menu page itself (not just after picking a mode) — browsers
		// block audio autoplay without a genuine user gesture, so this
		// is the earliest point it can reliably start.
		menu.addEventListener( 'pointerdown', startBgMusic, { once: true } );
		menu.addEventListener( 'keydown', startBgMusic, { once: true } );

	} );

}

// ─── "What's new" features modal ───────────────────────────
// Summarizes the major additions built on top of the original starter
// kit — opened from a link in the main menu's footer.

function showFeaturesModal() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-features-overlay {
			position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
			background: rgba(5,5,10,0.75); font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 24px 16px;
		}
		#hw-features-overlay .hwf-card {
			max-width: 460px; width: 100%; max-height: 82vh; overflow-y: auto;
			background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
			border: 1px solid rgba(139,95,191,0.4); border-radius: 20px; padding: 26px 22px;
			box-shadow: 0 0 50px rgba(91,60,140,0.25);
		}
		#hw-features-overlay .hwf-title {
			font-size: 26px; font-weight: 800; text-align: center;
			background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
			-webkit-background-clip: text; background-clip: text; color: transparent;
			margin-bottom: 4px;
		}
		#hw-features-overlay .hwf-sub { color: #9a94b0; font-size: 12px; text-align: center; margin-bottom: 20px; }
		#hw-features-overlay .hwf-row {
			display: flex; align-items: flex-start; gap: 12px; padding: 12px 0;
			border-top: 1px solid rgba(255,255,255,0.08);
		}
		#hw-features-overlay .hwf-row:first-of-type { border-top: none; }
		#hw-features-overlay .hwf-icon { font-size: 20px; line-height: 1.3; flex-shrink: 0; width: 26px; text-align: center; }
		#hw-features-overlay .hwf-label { color: #fff; font-size: 14.5px; font-weight: 600; margin-bottom: 2px; }
		#hw-features-overlay .hwf-desc { color: #a79fc4; font-size: 12.5px; line-height: 1.5; }
		#hw-features-overlay .hwf-close {
			display: block; width: 100%; margin-top: 20px; padding: 13px; border: none; border-radius: 999px;
			background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
		}
		#hw-features-overlay .hwf-about {
			background: rgba(139,95,191,0.1); border: 1px solid rgba(139,95,191,0.3); border-radius: 12px;
			padding: 12px 14px; margin-bottom: 18px; color: #cfc9e0; font-size: 12.5px; line-height: 1.7; text-align: center;
		}
		#hw-features-overlay .hwf-about b { color: #fff; }
	`;

	const FEATURES = [
		{ icon: '🕶️', label: 'وضع الواقع المعزز (AR)', desc: 'تشغيل حقيقي على Meta Quest 3 — تحدد مكان اللعب بغرفتك الحقيقية وتسوق بحرية كاملة بدون مضمار ثابت، مع سياج حماية يمنع السقوط من الحافة.' },
		{ icon: '🚙', label: 'اختيار لون/شكل السيارة', desc: '4 ألوان مختلفة تقدر تختارها قبل الدخول، تشوف صورة فعلية للسيارة قبل الاختيار.' },
		{ icon: '✏️', label: 'نص مخصص على السيارة', desc: 'اكتب أي كلمة أو اسم، ويظهر كملصق على الزجاج الأمامي والباب الخلفي.' },
		{ icon: '📻', label: 'راديو داخل السيارة', desc: '3 مقاطع صوتية تتحكم فيها أثناء القيادة — تبديل وتشغيل/إيقاف، بالكيبورد أو اللمس أو أيادي Quest.' },
		{ icon: '💡', label: 'إضاءة كاملة وواقعية', desc: 'أضواء أمامية حقيقية تضيء المكان، إضاءة عالية بالتكبيس، أضواء خلفية، وطوارئ برتقالية وامضة — كلها بأزرار تحكم مخصصة.' },
		{ icon: '🔎', label: 'تكبير وتصغير السيارة حي', desc: 'غيّر حجم السيارة أثناء اللعب مباشرة، مفيد لو تبي تلعب فوق طاولة بدل الأرض.' },
		{ icon: '🌍', label: 'تحكم حر بدون مضمار', desc: 'خيار بالوضع العادي كمان — أرضية مفتوحة واسعة تسوق فيها بحرية بدون قيود مضمار.' },
		{ icon: '📱', label: 'دعم كل الأجهزة', desc: 'يشتغل بالكيبورد، لمس الجوال، أو أيادي تحكم Quest — كل الميزات متاحة بأي طريقة تلعب فيها.' },
	];

	const overlay = document.createElement( 'div' );
	overlay.id = 'hw-features-overlay';
	overlay.dir = 'rtl';
	overlay.innerHTML = `
		<div class="hwf-card">
			<div class="hwf-title">هجولة عتابة</div>
			<div class="hwf-sub">مميزات اللعبة</div>
			<div class="hwf-about">
				طوّر هذه اللعبة <b>ABODEN GAMES</b> بمساعدة <b>Claude</b> من Anthropic.
				<br/>المشروع الأصلي: <b>Kenney</b> (تصميم) · <b>mrdoob</b> (Three.js) · <b>crashcat</b> (فيزياء).
			</div>
			${ FEATURES.map( ( f ) => `
				<div class="hwf-row">
					<div class="hwf-icon">${ f.icon }</div>
					<div>
						<div class="hwf-label">${ f.label }</div>
						<div class="hwf-desc">${ f.desc }</div>
					</div>
				</div>
			` ).join( '' ) }
			<button class="hwf-close">رجوع</button>
		</div>
	`;

	document.head.appendChild( style );
	document.body.appendChild( overlay );

	overlay.querySelector( '.hwf-close' ).addEventListener( 'click', () => overlay.remove() );
	overlay.addEventListener( 'click', ( e ) => { if ( e.target === overlay ) overlay.remove(); } );

}

// Soft radial-gradient glow texture (opaque center fading fully
// transparent at the edge) — used for the headlight halo so it looks
// like a real glow instead of a flat disc sitting on top of the lens.
function createGlowTexture( color ) {

	const size = 128;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	const grad = ctx.createRadialGradient( size / 2, size / 2, 0, size / 2, size / 2, size / 2 );
	grad.addColorStop( 0, `rgba(${ color }, 0.9)` );
	grad.addColorStop( 0.5, `rgba(${ color }, 0.35)` );
	grad.addColorStop( 1, `rgba(${ color }, 0)` );
	ctx.fillStyle = grad;
	ctx.fillRect( 0, 0, size, size );

	return new THREE.CanvasTexture( canvas );

}

// ─── Free-roam circuit environment (asphalt + grandstands) ──

function createAsphaltTexture() {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	// Matches the real track's own asphalt tone (0x3a3a40 — the same
	// value the AR floating arena already samples from the track's
	// shared palette texture) instead of the previous near-black
	// #232326, which read visibly darker/flatter than the actual race
	// track surface.
	ctx.fillStyle = '#3a3a40';
	ctx.fillRect( 0, 0, size, size );

	for ( let i = 0; i < 1400; i ++ ) {

		const x = Math.random() * size, y = Math.random() * size;
		const v = 20 + Math.random() * 30;
		ctx.fillStyle = `rgba(${ v },${ v },${ v + 2 },${ 0.25 + Math.random() * 0.3 })`;
		ctx.fillRect( x, y, 1.4, 1.4 );

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

// Subtle grid of dashed lane-marking lines — gives visual reference
// points scattered across the open paved area, loosely evoking street
// lane markings (useful even with the barrier/stand dressing, since the
// middle of a large arena can still feel empty without them).
function createLaneMarkingsTexture() {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	ctx.strokeStyle = 'rgba(255,255,255,0.5)';
	ctx.lineWidth = 3;
	ctx.setLineDash( [ 14, 14 ] );
	ctx.beginPath();
	ctx.moveTo( size / 2, 0 );
	ctx.lineTo( size / 2, size );
	ctx.moveTo( 0, size / 2 );
	ctx.lineTo( size, size / 2 );
	ctx.stroke();

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

function createSandTexture() {

	const size = 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#c9a877';
	ctx.fillRect( 0, 0, size, size );

	for ( let i = 0; i < 2200; i ++ ) {

		const x = Math.random() * size, y = Math.random() * size;
		const v = Math.random();
		const shade = v < 0.5 ? `rgba(150,120,80,${ 0.08 + Math.random() * 0.12 })` : `rgba(230,205,160,${ 0.08 + Math.random() * 0.15 })`;
		ctx.fillStyle = shade;
		ctx.fillRect( x, y, 1.6, 1.6 );

	}

	// Faint wind-ripple streaks
	ctx.strokeStyle = 'rgba(120,95,60,0.08)';
	ctx.lineWidth = 2;
	for ( let i = 0; i < 18; i ++ ) {

		const y = Math.random() * size;
		ctx.beginPath();
		ctx.moveTo( 0, y );
		ctx.bezierCurveTo( size * 0.3, y + ( Math.random() - 0.5 ) * 20, size * 0.7, y + ( Math.random() - 0.5 ) * 20, size, y );
		ctx.stroke();

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

// Large, non-repeating overlay of burnout circles and drift streaks laid
// once across the whole paved arena — a tiled texture would look
// obviously patterned at this scale, so this is drawn once at full size.
function createSkidMarksTexture( worldSize ) {

	const size = 1024;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );

	const toPx = ( w ) => ( w / worldSize + 0.5 ) * size;

	ctx.strokeStyle = 'rgba(10,10,12,0.35)';
	ctx.lineCap = 'round';

	// Burnout circles: paired concentric-ish rings with a slightly wobbly
	// radius, like a real donut/burnout mark.
	const circleCount = 7;
	for ( let c = 0; c < circleCount; c ++ ) {

		const cx = toPx( ( Math.random() - 0.5 ) * worldSize * 0.75 );
		const cy = toPx( ( Math.random() - 0.5 ) * worldSize * 0.75 );
		const r = size * ( 0.02 + Math.random() * 0.035 );

		for ( const offset of [ -3, 3 ] ) {

			ctx.lineWidth = 2.5 + Math.random() * 1.5;
			ctx.beginPath();
			const segs = 48;
			for ( let i = 0; i <= segs; i ++ ) {

				const a = ( i / segs ) * Math.PI * 2;
				const wob = Math.sin( a * 5 + c ) * r * 0.05;
				const px = cx + Math.cos( a ) * ( r + offset + wob );
				const py = cy + Math.sin( a ) * ( r + offset + wob );
				if ( i === 0 ) ctx.moveTo( px, py ); else ctx.lineTo( px, py );

			}

			ctx.stroke();

		}

	}

	// Long curved drift trails: pairs of near-parallel tracks following a
	// sweeping bezier path.
	const trailCount = 10;
	for ( let t = 0; t < trailCount; t ++ ) {

		const x0 = ( Math.random() - 0.5 ) * worldSize * 0.9;
		const y0 = ( Math.random() - 0.5 ) * worldSize * 0.9;
		const ang = Math.random() * Math.PI * 2;
		const len = worldSize * ( 0.15 + Math.random() * 0.25 );
		const bend = ( Math.random() - 0.5 ) * len * 0.6;

		const x1 = x0 + Math.cos( ang ) * len;
		const y1 = y0 + Math.sin( ang ) * len;
		const mx = ( x0 + x1 ) / 2 - Math.sin( ang ) * bend;
		const my = ( y0 + y1 ) / 2 + Math.cos( ang ) * bend;

		for ( const offset of [ -4, 4 ] ) {

			ctx.lineWidth = 3 + Math.random();
			ctx.globalAlpha = 0.5 + Math.random() * 0.3;
			ctx.beginPath();
			ctx.moveTo( toPx( x0 + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( y0 + Math.sin( ang + Math.PI / 2 ) * offset ) );
			ctx.quadraticCurveTo(
				toPx( mx + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( my + Math.sin( ang + Math.PI / 2 ) * offset ),
				toPx( x1 + Math.cos( ang + Math.PI / 2 ) * offset ), toPx( y1 + Math.sin( ang + Math.PI / 2 ) * offset )
			);
			ctx.stroke();

		}

	}
	ctx.globalAlpha = 1;

	const texture = new THREE.CanvasTexture( canvas );
	return texture;

}

// Racing curb (kerb) edge marking for the open drift arenas — a white
// boundary band running just inside the barrier, with red rumble-strip
// blocks spaced along it, in the same accent red (0xE0621B) already used
// by buildBarrierSegment's own barrier stripe so the two read as one
// consistent "track style" rather than two unrelated colors. Painted
// once across the whole square footprint (same non-repeating-overlay
// technique as createSkidMarksTexture) so the band traces the actual
// perimeter regardless of how large the arena is.
// `worldSize` is the full plane size the texture will be mapped onto;
// `half` is the arena's own half-size (footprint edge distance from
// center) in those same world units.
// worldSizeX/worldSizeZ + halfX/halfZ are now independent (were a single
// worldSize/half assuming a square footprint) so this also maps correctly
// onto a rectangular pad — separate per-axis pixel scales, and the
// perimeter rumble-strip blocks are laid out along each axis using that
// axis's own half-length. Callers with a square footprint just pass the
// same value for both (X/Z), producing byte-identical output to before.
function createTrackEdgeTexture( worldSizeX, worldSizeZ, halfX, halfZ ) {

	const size = 1024;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext( '2d' );

	const pxX = size / worldSizeX; // pixels per world unit, X axis
	const pxZ = size / worldSizeZ; // pixels per world unit, Z axis
	const toPxX = ( w ) => ( w / worldSizeX + 0.5 ) * size;
	const toPxZ = ( w ) => ( w / worldSizeZ + 0.5 ) * size;

	const refHalf = Math.min( halfX, halfZ ); // band thickness stays consistent regardless of aspect ratio
	const bandWidth = Math.max( refHalf * 0.014, 0.4 );  // white band thickness
	const inset = Math.max( refHalf * 0.01, 0.35 );       // gap between the barrier and the band's outer edge
	const blockLen = bandWidth * 2.1;                  // length of each red block along the band
	const gapLen = bandWidth * 1.6;                    // white gap between red blocks

	const outerX = halfX - inset, innerX = outerX - bandWidth;
	const outerZ = halfZ - inset, innerZ = outerZ - bandWidth;
	const bandPxX = bandWidth * pxX;
	const bandPxZ = bandWidth * pxZ;

	// White boundary band, all 4 sides at once (full-canvas-width/height
	// strips so the corners overlap cleanly with no gap).
	ctx.fillStyle = '#f2f2f2';
	ctx.fillRect( 0, toPxZ( -outerZ ), size, bandPxZ );
	ctx.fillRect( 0, toPxZ( innerZ ), size, bandPxZ );
	ctx.fillRect( toPxX( -outerX ), 0, bandPxX, size );
	ctx.fillRect( toPxX( innerX ), 0, bandPxX, size );

	// Red rumble-strip blocks laid on top at regular intervals — one pass
	// along each axis, since the two can now have different lengths.
	ctx.fillStyle = '#E0621B';
	const period = blockLen + gapLen;
	for ( let p = - halfX; p < halfX; p += period ) {

		const len = Math.min( blockLen, halfX - p );
		if ( len <= 0 ) continue;
		const lenPx = len * pxX;
		const startPx = toPxX( p );

		ctx.fillRect( startPx, toPxZ( -outerZ ), lenPx, bandPxZ );
		ctx.fillRect( startPx, toPxZ( innerZ ), lenPx, bandPxZ );

	}
	for ( let p = - halfZ; p < halfZ; p += period ) {

		const len = Math.min( blockLen, halfZ - p );
		if ( len <= 0 ) continue;
		const lenPx = len * pxZ;
		const startPx = toPxZ( p );

		ctx.fillRect( toPxX( -outerX ), startPx, bandPxX, lenPx );
		ctx.fillRect( toPxX( innerX ), startPx, bandPxX, lenPx );

	}

	// Canvas stays transparent outside the drawn bands — meant to be
	// layered over the asphalt, not replace it.
	const texture = new THREE.CanvasTexture( canvas );
	return texture;

}

function createCrowdTexture() {

	const w = 256, h = 64;
	const canvas = document.createElement( 'canvas' );
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#1c1f26';
	ctx.fillRect( 0, 0, w, h );

	const colors = [ '#e2725b', '#f2c230', '#4CAF6D', '#5B8CFF', '#f4f4f4', '#8B5FBF', '#D9534F' ];
	for ( let y = 6; y < h; y += 9 ) {

		const rowOffset = ( Math.round( y / 9 ) % 2 === 0 ) ? 4 : 8.5;
		for ( let x = rowOffset; x < w; x += 8.5 ) {

			ctx.fillStyle = colors[ Math.floor( Math.random() * colors.length ) ];
			ctx.beginPath();
			ctx.arc( x, y, 2.5, 0, Math.PI * 2 );
			ctx.fill();

		}

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	return texture;

}

// Builds a 3-tier stepped grandstand (like Riyadh's Reem circuit) along
// one perimeter wall. axis 'x' = wall runs along X (north/south walls,
// fixedCoord is their Z); axis 'z' = wall runs along Z (east/west walls,
// fixedCoord is their X). direction (+1/-1) is which way it extends
// away from the track.
// Real asset (models/barrier-segment.glb, 8 units long) placed in a
// closed loop around a square footprint — shared between the AR drift
// pad and (now) the web free-roam arena, so both use the same visual
// barrier style as the actual race track instead of a separate
// grandstand design.
// Same red/white striped barrier the actual race track uses
// (buildBarrierSegment, runtime-built geometry) placed in a closed loop
// around a square footprint — shared between the web free-roam arena
// and the AR drift pad. Previously used custom-exported GLB assets
// (ground-tile.glb/barrier-segment.glb) instead, but those were
// rendering incorrectly (wrong/washed-out color, barrier segments
// appearing as small disconnected posts instead of continuous barrier
// walls) for reasons not fully root-caused — reverted to this
// proven-working runtime approach rather than keep chasing the asset
// pipeline issue.
// halfZ defaults to halfX, so an existing (square) caller that only ever
// passed one half-length keeps producing exactly the same barrier loop as
// before; a rectangular caller passes both independently.
function buildBarrierLoop( parentGroup, world, halfX, halfZ = halfX, yOffset = 0, heightScale = 1 ) {

	const barrierSeg = 8;

	for ( const sign of [ 1, -1 ] ) {

		for ( let p = - halfX; p < halfX; p += barrierSeg ) {

			const segLen = Math.min( barrierSeg, halfX - p ) - 0.3; // small gaps between segments, like real jersey barrier sections
			if ( segLen <= 0 ) continue;
			const center = p + segLen / 2;

			buildBarrierSegment( parentGroup, world, center, sign * halfZ, segLen, 'x', yOffset, heightScale );

		}

		for ( let p = - halfZ; p < halfZ; p += barrierSeg ) {

			const segLen = Math.min( barrierSeg, halfZ - p ) - 0.3;
			if ( segLen <= 0 ) continue;
			const center = p + segLen / 2;

			buildBarrierSegment( parentGroup, world, sign * halfX, center, segLen, 'z', yOffset, heightScale );

		}

	}

}

function buildGrandstandWall( scene, axis, length, fixedCoord, baseDistance, direction ) {

	// Many small rows (realistic stadium riser height, ~0.45m per step)
	// instead of a few huge tiers — each individual step should read as
	// smaller than the car, not towering over it.
	const rowHeight = 0.45, rowDepth = 1.3, numRows = 6;
	const tiers = [];
	for ( let i = 0; i < numRows; i ++ ) tiers.push( { h: rowHeight * ( i + 1 ), d: rowDepth } );
	let offset = 0;

	tiers.forEach( ( t ) => {

		const centerDist = baseDistance + offset + t.d / 2;
		const sizeX = axis === 'x' ? length : t.d;
		const sizeZ = axis === 'x' ? t.d : length;

		const texture = createCrowdTexture();
		texture.repeat.set( axis === 'x' ? length / 4 : 1,
			axis === 'x' ? 1 : length / 4 );

		const material = new THREE.MeshStandardMaterial( { map: texture, roughness: 1, metalness: 0 } );
		const mesh = new THREE.Mesh( new THREE.BoxGeometry( sizeX, t.h, sizeZ ), material );
		mesh.position.set(
			axis === 'x' ? 0 : fixedCoord + direction * centerDist,
			t.h / 2,
			axis === 'x' ? fixedCoord + direction * centerDist : 0
		);
		mesh.receiveShadow = true;
		scene.add( mesh );

		offset += t.d;

	} );

}

// Stadium floodlight pole: a tall mast + lamp head, with a real SpotLight
// aiming down at the track — matching the bright white floodlights over
// a real night "تفحيط" show.
function buildFloodlightPole( scene, x, z, aimTarget, world = null ) {

	const poleHeight = 9;
	const pole = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.12, 0.16, poleHeight, 8 ),
		new THREE.MeshStandardMaterial( { color: 0x3a3a3e, roughness: 0.7, metalness: 0.4 } )
	);
	pole.position.set( x, poleHeight / 2, z );
	pole.castShadow = true;
	scene.add( pole );

	// Small lamp head cluster at the top, tilted toward the track.
	const headGroup = new THREE.Group();
	headGroup.position.set( x, poleHeight - 0.1, z );
	headGroup.lookAt( aimTarget.x, 0, aimTarget.z );
	scene.add( headGroup );

	const headMat = new THREE.MeshStandardMaterial( { color: 0x111114, roughness: 0.5, metalness: 0.6 } );
	for ( let i = -1; i <= 1; i ++ ) {

		const lamp = new THREE.Mesh( new THREE.BoxGeometry( 0.5, 0.35, 0.15 ), headMat );
		lamp.position.set( i * 0.6, 0, 0.3 );
		lamp.rotation.x = -0.5;
		headGroup.add( lamp );

	}

	const light = new THREE.SpotLight( 0xf5f7ff, 45, 70, THREE.MathUtils.degToRad( 42 ), 0.4, 1.0 );
	light.position.set( x, poleHeight - 0.1, z );
	light.target.position.set( aimTarget.x, 0, aimTarget.z );
	light.castShadow = false; // 4 shadow-casting spotlights would be very expensive; dirLight still casts the car's shadow
	scene.add( light );
	scene.add( light.target );

	// Solid collider so the car actually crashes into the pole instead of
	// driving straight through it — a Y-axis cylinder (crashcat has a real
	// cylinder shape, registered via registerAll()) matching the pole
	// mesh's own radius/height, so it's a snug fit rather than a boxy
	// approximation.
	if ( world ) {

		rigidBody.create( world, {
			shape: cylinder.create( { halfHeight: poleHeight / 2, radius: 0.16 } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ x, poleHeight / 2, z ],
			friction: 0.4,
			restitution: 0.15,
		} );

	}

}

// ─── Drift arena dressing: barriers, tire stacks, gate, signs ─

// Concrete jersey barrier segment: gray base + a painted orange/white
// hazard stripe near the top, the standard look for track-edge barriers.
function buildBarrierSegment( scene, world, x, z, length, axis, yOffset = 0, heightScale = 1 ) {

	const h = 0.6 * heightScale, w = 0.35;
	const sizeX = axis === 'x' ? length : w;
	const sizeZ = axis === 'x' ? w : length;

	const body = new THREE.Mesh(
		new THREE.BoxGeometry( sizeX, h, sizeZ ),
		new THREE.MeshStandardMaterial( { color: 0x9a9a92, roughness: 0.95, metalness: 0 } )
	);
	body.position.set( x, h / 2 + yOffset, z );
	body.castShadow = true;
	body.receiveShadow = true;
	scene.add( body );

	const stripe = new THREE.Mesh(
		new THREE.BoxGeometry( axis === 'x' ? sizeX : sizeX * 1.02, 0.12 * heightScale, axis === 'x' ? sizeZ * 1.02 : sizeZ ),
		new THREE.MeshStandardMaterial( { color: 0xE0621B, roughness: 0.8 } )
	);
	stripe.position.set( x, h * 0.72 + yOffset, z );
	scene.add( stripe );

	if ( world ) {

		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ sizeX / 2, h / 2, sizeZ / 2 ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ x, h / 2 - 0.125 + yOffset, z ],
			friction: 0.3,
			restitution: 0.25,
		} );

	}

}

// A stack of tires (torus "tires", genuinely stacked) — decorative corner
// dressing, common at any real drift arena's edge.
function buildTireStack( scene, x, z, count ) {

	const tireMat = new THREE.MeshStandardMaterial( { color: 0x1c1c1e, roughness: 0.9, metalness: 0 } );
	let y = 0.12;

	for ( let i = 0; i < count; i ++ ) {

		const tire = new THREE.Mesh( new THREE.TorusGeometry( 0.35, 0.13, 10, 20 ), tireMat );
		tire.rotation.x = Math.PI / 2;
		tire.position.set( x + ( Math.random() - 0.5 ) * 0.04, y, z + ( Math.random() - 0.5 ) * 0.04 );
		tire.castShadow = true;
		tire.receiveShadow = true;
		scene.add( tire );
		y += 0.23;

	}

}

// Entrance gate: two pillars + a header beam, straddling one edge of the
// arena — purely a visual landmark (the barrier line behind it is still
// the actual boundary).
function buildEntranceGate( scene, x, z, axis ) {

	const pillarH = 4.2, pillarSize = 0.35, gap = 3.6;
	const mat = new THREE.MeshStandardMaterial( { color: 0x2c2c30, roughness: 0.6, metalness: 0.5 } );

	for ( const side of [ -1, 1 ] ) {

		const px = axis === 'x' ? x + side * gap / 2 : x;
		const pz = axis === 'x' ? z : z + side * gap / 2;
		const pillar = new THREE.Mesh( new THREE.BoxGeometry( pillarSize, pillarH, pillarSize ), mat );
		pillar.position.set( px, pillarH / 2, pz );
		pillar.castShadow = true;
		scene.add( pillar );

	}

	const beam = new THREE.Mesh(
		new THREE.BoxGeometry( axis === 'x' ? gap + pillarSize : pillarSize, 0.4, axis === 'x' ? pillarSize : gap + pillarSize ),
		mat
	);
	beam.position.set( x, pillarH + 0.2, z );
	beam.castShadow = true;
	scene.add( beam );

}

// Warning sign: yellow triangle on a post — no text/glyphs, just the
// hazard-triangle shape.
function buildWarningSign( scene, x, z, rotationY ) {

	const post = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.03, 0.03, 1.1, 6 ),
		new THREE.MeshStandardMaterial( { color: 0x333333, roughness: 0.7 } )
	);
	post.position.set( x, 0.55, z );
	scene.add( post );

	const shape = new THREE.Shape();
	shape.moveTo( 0, 0.32 );
	shape.lineTo( -0.28, -0.18 );
	shape.lineTo( 0.28, -0.18 );
	shape.closePath();

	const face = new THREE.Mesh(
		new THREE.ShapeGeometry( shape ),
		new THREE.MeshStandardMaterial( { color: 0xF2C230, roughness: 0.6, side: THREE.DoubleSide } )
	);
	const border = new THREE.Mesh(
		new THREE.RingGeometry( 0.26, 0.30, 3 ),
		new THREE.MeshStandardMaterial( { color: 0x1a1a1a, roughness: 0.6, side: THREE.DoubleSide } )
	);
	border.rotation.z = Math.PI; // point the ring-triangle the same way as the face

	const signGroup = new THREE.Group();
	signGroup.add( face );
	signGroup.add( border );
	signGroup.position.set( x, 1.15, z );
	signGroup.rotation.y = rotationY;
	scene.add( signGroup );

}

// Floodlight pole for contexts like the AR floating arena where the whole
// group gets scaled down to tabletop size — takes a `scale` (the same
// FIXED_SCALE knob used everywhere else) and scales the SpotLight's
// distance/intensity down by it too, exactly like updateVehicleLights()
// scales headlight/taillight/hazard base values. A real-world-scale light
// (base 45/70, matching buildFloodlightPole) would blow out the tiny
// scaled-down scene, hence the scaling instead of just omitting the light.
function buildFloodlightPoleVisual( parent, x, z, aimTarget, poleHeight = 9, scale = 1 ) {

	const pole = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.12, 0.16, poleHeight, 8 ),
		new THREE.MeshStandardMaterial( { color: 0x3a3a3e, roughness: 0.7, metalness: 0.4 } )
	);
	pole.position.set( x, poleHeight / 2, z );
	pole.castShadow = true;
	parent.add( pole );

	const headGroup = new THREE.Group();
	headGroup.position.set( x, poleHeight - 0.1, z );
	headGroup.lookAt( aimTarget.x, 0, aimTarget.z );
	parent.add( headGroup );

	const headMat = new THREE.MeshStandardMaterial( { color: 0x111114, roughness: 0.5, metalness: 0.6 } );
	for ( let i = -1; i <= 1; i ++ ) {

		const lamp = new THREE.Mesh( new THREE.BoxGeometry( 0.5, 0.35, 0.15 ), headMat );
		lamp.position.set( i * 0.6, 0, 0.3 );
		lamp.rotation.x = -0.5;
		headGroup.add( lamp );

	}

	// Real light, scaled down with `scale` — object scale on the parent
	// group moves the light's position correctly but does NOT scale
	// .distance/.intensity, so those are scaled here explicitly. No
	// shadow (4+ shadow-casting spotlights on top of the arena's own
	// directional light is exactly the double-shadow-pass cost that
	// caused the AR reprojection judder fixed earlier this session).
	const s = Math.max( scale, 0.001 );
	const light = new THREE.SpotLight( 0xf5f7ff, 45 * s, 70 * s, THREE.MathUtils.degToRad( 42 ), 0.4, 1.0 );
	light.position.set( x, poleHeight - 0.1, z );
	light.target.position.set( aimTarget.x, 0, aimTarget.z );
	light.castShadow = false;
	parent.add( light );
	parent.add( light.target );

}

// Tire stacks + a parked decoration car scattered near each of the
// arena's 4 corners — random tire count and a little position jitter
// each time so the four corners don't look copy-pasted, and a randomly
// picked truck model parked nearby (skipped occasionally so it's not
// mechanically "always all 4 corners"). Shared between the web
// free-roam arena and the AR floating arena/drift pad; `parent` is
// whatever group/scene those add their own dressing to, so this works
// unscaled (world space) or inside a group that later gets uniformly
// scaled down for AR.
// halfZ defaults to halfX (square, backward-compatible); a rectangular
// caller passes both independently so each corner cluster sits inset
// proportionally on both axes instead of assuming a square footprint.
// Always returns the list of what it actually placed (position/rotation/
// tire count) so a caller can build matching physics colliders — either
// right away by passing `world` (web free-roam, where the physics world
// already exists at call time), or later from the returned list once it
// does exist (the AR arena, whose physics world isn't created until
// lock-in, well after this runs at preview time — see buildDriftPad).
function scatterCornerDecor( parent, models, halfX, halfZ = halfX, truckKeys, world = null ) {

	const marginX = halfX * 0.14; // how far inside the corner the cluster sits
	const marginZ = halfZ * 0.14;
	const jitterX = halfX * 0.05;
	const jitterZ = halfZ * 0.05;

	const decor = [];

	for ( const sx of [ -1, 1 ] ) {

		for ( const sz of [ -1, 1 ] ) {

			const cx = sx * ( halfX - marginX );
			const cz = sz * ( halfZ - marginZ );

			const tireCount = 3 + Math.floor( Math.random() * 4 ); // 3-6
			const tireX = cx + ( Math.random() - 0.5 ) * jitterX * 2;
			const tireZ = cz + ( Math.random() - 0.5 ) * jitterZ * 2;
			buildTireStack( parent, tireX, tireZ, tireCount );
			decor.push( { type: 'tires', x: tireX, z: tireZ, count: tireCount } );

			if ( truckKeys.length > 0 && Math.random() < 0.85 ) {

				const key = truckKeys[ Math.floor( Math.random() * truckKeys.length ) ];
				const src = models[ key ];

				if ( src ) {

					const car = src.clone();
					// Offset toward the arena's center relative to the tire
					// stack, away from the corner point, so the two don't
					// overlap each other.
					const carX = cx - sx * jitterX * 1.8 + ( Math.random() - 0.5 ) * jitterX;
					const carZ = cz - sz * jitterZ * 1.8 + ( Math.random() - 0.5 ) * jitterZ;
					car.position.set( carX, 0, carZ );
					car.rotation.y = Math.random() * Math.PI * 2;
					car.traverse( ( c ) => {

						if ( c.isMesh ) { c.castShadow = true; c.receiveShadow = true; }

					} );
					parent.add( car );
					decor.push( { type: 'car', x: carX, z: carZ, rotationY: car.rotation.y } );

				}

			}

		}

	}

	if ( world ) addDecorColliders( world, decor );

	return decor;

}

// Static colliders matching scatterCornerDecor()'s placed tire stacks/
// decoration cars, so the car actually crashes into them instead of
// driving straight through — same idea as buildFloodlightPole's new
// collider. The tire stack (a bundle of tori) is approximated as a
// cylinder of the same footprint/height; crashcat has no compound-mesh
// shape that would match the real stacked-tire silhouette. The
// decoration car is a rotated box (crashcat's `quaternion` body setting)
// sized like a real pickup truck, matching its randomized rotation.y so
// the collider actually lines up with however the model was placed.
function addDecorColliders( world, decorList, yOffset = 0 ) {

	const _q = new THREE.Quaternion();
	const _up = new THREE.Vector3( 0, 1, 0 );

	for ( const d of decorList ) {

		if ( d.type === 'tires' ) {

			const stackHeight = 0.12 + d.count * 0.23; // matches buildTireStack's own y progression
			rigidBody.create( world, {
				shape: cylinder.create( { halfHeight: stackHeight / 2, radius: 0.42 } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ d.x, stackHeight / 2 + yOffset, d.z ],
				friction: 0.5,
				restitution: 0.2,
			} );

		} else if ( d.type === 'car' ) {

			_q.setFromAxisAngle( _up, d.rotationY );
			const halfW = 0.95, halfH = 0.65, halfL = 1.95; // rough real-world pickup-truck footprint
			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ halfW, halfH, halfL ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ d.x, halfH + yOffset, d.z ],
				quaternion: [ _q.x, _q.y, _q.z, _q.w ],
				friction: 0.4,
				restitution: 0.25,
			} );

		}

	}

}

// ─── Custom windshield/tailgate text decal ─────────────────

function createTextTexture( text ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 512;
	canvas.height = 256;
	const ctx = canvas.getContext( '2d' );
	ctx.clearRect( 0, 0, 512, 256 );

	// Basic Arabic-range check so RTL text is drawn with correct direction;
	// canvas glyph shaping/joining works either way, this mainly affects
	// alignment when the string mixes scripts.
	if ( /[\u0600-\u06FF]/.test( text ) ) ctx.direction = 'rtl';

	ctx.font = 'bold 110px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.lineJoin = 'round';
	ctx.lineWidth = 10;
	ctx.strokeStyle = '#000000';
	ctx.strokeText( text, 256, 128 );
	ctx.fillStyle = '#ffffff';
	ctx.fillText( text, 256, 128 );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;

}

// Adds the user's custom text on the windshield (facing forward) and the
// tailgate (facing backward), as children of the model's "body" node so
// they inherit its position/suspension-lean animation automatically.
// Coordinates match the pickup body built for this project (see the body
// mesh authored for vehicle-truck-yellow.glb) — purely cosmetic decals,
// no change to Vehicle.js or the model's own geometry.
function addCustomTextDecals( vehicleGroup, text ) {

	if ( ! text ) return;

	const vehicleModel = vehicleGroup.children[ 0 ];
	let bodyNode = null;
	vehicleModel.traverse( ( child ) => {

		if ( child.name.toLowerCase() === 'body' ) bodyNode = child;

	} );
	if ( ! bodyNode ) return;

	const texture = createTextTexture( text );
	const material = new THREE.MeshBasicMaterial( {
		// Single-sided on purpose: with DoubleSide, the front decal's
		// back face was visible (mirrored) from behind the vehicle over
		// the roofline, and vice versa for the rear decal. FrontSide
		// means each sticker only shows from its own correct side, like
		// a real decal.
		map: texture, transparent: true, depthWrite: false, side: THREE.FrontSide,
	} );

	// Coordinates measured directly from the actual shipped model's mesh
	// (vehicle-truck-*.glb — same body geometry across all 4 colors).
	// Windshield glass: center of mass (0, 0.42, 0.48), max z 0.548 —
	// decal sized to sit inside the glass panel itself (not the whole
	// frame) and offset just enough past the glass surface to avoid
	// z-fighting, like a sticker applied to the glass.
	const windshieldDecal = new THREE.Mesh( new THREE.PlaneGeometry( 0.62, 0.34 ), material );
	windshieldDecal.position.set( 0, 0.66, 0.57 );
	windshieldDecal.renderOrder = 10;
	bodyNode.add( windshieldDecal );

	// Rear window/panel: x:[-0.67,0.67] y:[0.09,0.5] z:[-1.4,-1.27].
	const tailgateDecal = new THREE.Mesh( new THREE.PlaneGeometry( 1.0, 0.5 ), material );
	tailgateDecal.position.set( 0, 0.28, -1.43 );
	tailgateDecal.rotation.y = Math.PI; // face backward
	tailgateDecal.renderOrder = 10;
	bodyNode.add( tailgateDecal );

}

// ─── Rear flag: pole-mounted, driver's-side corner ───────────
// Saudi Arabia drives left-hand-drive (driver's seat on the left), so
// "driver's side" = the vehicle's left = negative local x, matching the
// side=-1 convention already used for the taillights/reverse lights
// below. Mounted low, at rear-bumper/spare-tire height (not roof height)
// and near the left edge — matching a real full-size flag planted at the
// back of the vehicle, leaning up and outward, rather than a small
// roof-mounted pennant.
function addVehicleFlag( vehicleGroup, imageUrl ) {

	const vehicleModel = vehicleGroup.children[ 0 ];
	let bodyNode = null;
	vehicleModel.traverse( ( child ) => {

		if ( child.name.toLowerCase() === 'body' ) bodyNode = child;

	} );
	if ( ! bodyNode ) return null;

	const flag = createFlag( imageUrl );
	// Pole planted right at the rear bumper — pulled left (clear of the
	// bumper's width) and just past its depth, not floating away from it.
	flag.group.position.set( -0.6, 0.14, -1.36 );
	bodyNode.add( flag.group );

	return flag;

}

// ─── Real headlight / taillight lighting ───────────────────
// Coordinates measured directly from the model's actual headlight/
// taillight faces: left/right headlights at x:∓0.4, y:0.3, z:1.4;
// left/right taillights at x:∓0.4, y:0.43, z:-1.3. Attached to the
// same "body" node as the text decals, so they move and scale with
// the car (including the live resize control) automatically.
function addVehicleLights( vehicleGroup ) {

	const vehicleModel = vehicleGroup.children[ 0 ];
	let bodyNode = null;
	vehicleModel.traverse( ( child ) => {

		if ( child.name.toLowerCase() === 'body' ) bodyNode = child;

	} );
	if ( ! bodyNode ) return null;

	// Headlights: warm-white point lights, lighting up the real room
	// ahead in AR. Off by default — toggled by the player.
	// Mounted well above and ahead of the car (like a roof light bar)
	// instead of right at the bumper — being that close to the car's own
	// paint was overexposing/whiting-out the car itself (inverse-square
	// falloff means intensity right next to the source is extreme) while
	// barely reaching the room a couple meters out.
	// Headlights: warm-white spotlights, lighting up the real room ahead
	// in AR. Off by default — toggled by the player.
	// A PointLight mounted on the car always over-lit the car itself no
	// matter how far out it was pushed, since the car's own body is
	// rigidly attached nearby while the room is much farther — the car
	// dominates the illumination by inverse-square law regardless of
	// placement. Switched to a narrow directional SpotLight mounted
	// clear above the roof (not touching any geometry, unlike the first
	// SpotLight attempt) and aimed forward with a gentle downward tilt
	// calculated to clear the hood/roof entirely, so the beam only ever
	// hits the room, never the car's own body.
	// ✏️ THIS is where headlight brightness actually comes from —
	// baseIntensity below, not the intensityScale multiplier in
	// updateVehicleLights()/setHighBeam() further down this file (that
	// multiplier only scales this base number down for AR's tiny
	// FIXED_SCALE; in NORMAL/web mode scale=1 so the light renders at
	// exactly this baseIntensity, unscaled). Cut hard (3000 → 500, ~83%)
	// per feedback that it was still far too strong after the earlier
	// scaling-curve fix — that fix only affected AR's relative dimming,
	// it never touched this base number, so web mode never actually got
	// dimmer from it. Lower this single number to dim headlights further
	// (setHighBeam()'s high-beam boost is a flat ×2.5 on top of whatever
	// this is, so it scales down together with it automatically).
	const headlights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 14;
		const baseIntensity = 500;
		const light = new THREE.SpotLight( 0xfff2cc, baseIntensity, baseDistance, Math.PI / 8, 0.35, 2 );
		const basePosition = new THREE.Vector3( side * 0.3, 1.05, 1.0 ); // clear above the roof, open air
		light.position.copy( basePosition );
		light.visible = false;

		const target = new THREE.Object3D();
		const baseTargetPosition = new THREE.Vector3( side * 0.3, 0.1, 9 ); // far ahead, gentle downward slope
		target.position.copy( baseTargetPosition );
		bodyNode.add( target );
		light.target = target;

		bodyNode.add( light );
		headlights.push( { light, target, basePosition, baseTargetPosition, baseDistance, baseIntensity } );

	}

	// Glowing "lens" overlays at the actual headlight bumps on the body
	// (measured earlier: x:∓0.4, y:~0.3, z:1.4) — separate from the
	// actual illuminating light above, which is roof-mounted so its beam
	// clears the car. This is purely visual: makes the headlight bump
	// itself look lit (bright white with a soft glow) when toggled on,
	// since the shared body material can't be selectively recolored
	// without touching the model file.
	const headlightLenses = [];
	for ( const side of [ -1, 1 ] ) {

		const group = new THREE.Group();
		const basePosition = new THREE.Vector3( side * 0.4, 0.3, 1.41 );
		group.position.copy( basePosition );
		group.userData.basePosition = basePosition;
		group.visible = false;

		const core = new THREE.Mesh(
			new THREE.CircleGeometry( 0.075, 16 ),
			new THREE.MeshBasicMaterial( { color: 0xffffff, toneMapped: false } )
		);
		group.add( core );

		const halo = new THREE.Mesh(
			new THREE.CircleGeometry( 0.16, 24 ),
			new THREE.MeshBasicMaterial( {
				map: createGlowTexture( '255, 242, 204' ), color: 0xfff2cc,
				transparent: true, toneMapped: false, depthWrite: false,
				blending: THREE.AdditiveBlending,
			} )
		);
		halo.position.z = -0.002; // just behind the core, avoids z-fighting
		group.add( halo );

		bodyNode.add( group );
		headlightLenses.push( group );

	}

	// Taillights: small, short-range red glow, always on — real
	// taillights don't meaningfully illuminate anything, this is just a
	// soft tint near the rear. (Kept at the same intensity that already
	// looked right — short range makes it visible even at low candela.)
	const taillights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 0.9;
		const baseIntensity = 0.8;
		const light = new THREE.PointLight( 0xff3b30, baseIntensity, baseDistance, 2 );
		const basePosition = new THREE.Vector3( side * 0.4, 0.43, -1.32 );
		light.position.copy( basePosition );
		bodyNode.add( light );
		taillights.push( { light, basePosition, baseDistance, baseIntensity } );

	}

	// Reverse (backup) lights: white glow at the rear, next to the
	// taillights, only lit while the car is actually reversing (driven
	// from linearSpeed < 0 in updateVehicleLights — no manual toggle,
	// same as a real car). Small lens glow like the headlight bumps —
	// intentionally subtle/small (a real backup light is a dim little
	// bulb, not a headlight-strength beam).
	const reverseLights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 0.8;
		const baseIntensity = 1.2;
		const light = new THREE.PointLight( 0xf5f9ff, baseIntensity, baseDistance, 2 );
		const basePosition = new THREE.Vector3( side * 0.25, 0.43, -1.34 );
		light.position.copy( basePosition );
		light.visible = false;
		bodyNode.add( light );

		const lens = new THREE.Mesh(
			new THREE.CircleGeometry( 0.035, 16 ),
			new THREE.MeshBasicMaterial( { color: 0xffffff, toneMapped: false } )
		);
		lens.position.copy( basePosition );
		lens.rotation.y = Math.PI; // face backward, out through the taillight bump
		lens.visible = false;
		bodyNode.add( lens );

		reverseLights.push( { light, lens, basePosition, baseDistance, baseIntensity } );

	}

	// Hazard/emergency lights: orange, blinking, at all 4 corners. Off
	// by default — toggled by the player, blink handled per-frame.
	const hazards = [];
	const hazardPositions = [
		[ -0.4, 0.3, 1.42 ], [ 0.4, 0.3, 1.42 ],
		[ -0.4, 0.43, -1.32 ], [ 0.4, 0.43, -1.32 ],
	];
	for ( const [ x, y, z ] of hazardPositions ) {

		const baseDistance = 0.8;
		const baseIntensity = 3;
		const light = new THREE.PointLight( 0xff8c1a, baseIntensity, baseDistance, 2 );
		const basePosition = new THREE.Vector3( x, y, z );
		light.position.copy( basePosition );
		light.visible = false;
		bodyNode.add( light );
		hazards.push( { light, basePosition, baseDistance, baseIntensity } );

	}

	return { headlights, taillights, hazards, headlightLenses, reverseLights };

}

// ─── Shared light control helpers (used by both modes) ─────

function toggleHeadlights( vehicleLights ) {

	if ( ! vehicleLights ) return;
	const on = ! vehicleLights.headlights[ 0 ].light.visible;
	vehicleLights.headlights.forEach( ( h ) => { h.light.visible = on; } );
	if ( vehicleLights.headlightLenses ) {

		vehicleLights.headlightLenses.forEach( ( lens ) => { lens.visible = on; } );

	}

}

function toggleHazards( vehicleLights ) {

	if ( ! vehicleLights ) return;
	vehicleLights.hazardsOn = ! vehicleLights.hazardsOn;
	if ( ! vehicleLights.hazardsOn ) {

		vehicleLights.hazards.forEach( ( h ) => { h.light.visible = false; } );

	}

}

// High beam is held, not toggled — while held, headlights go brighter
// and farther-reaching (and force ON even if the player hadn't turned
// regular headlights on, matching a real high-beam flasher stalk).
function setHighBeam( vehicleLights, on, scale = 1 ) {

	if ( ! vehicleLights ) return;
	if ( vehicleLights._highBeamOn === on ) return; // no change, skip

	if ( on ) vehicleLights._headlightsBeforeHighBeam = vehicleLights.headlights[ 0 ].light.visible;
	vehicleLights._highBeamOn = on;

	const s = Math.max( scale, 0.001 );
	const intensityScale = s;

	vehicleLights.headlights.forEach( ( h ) => {

		if ( on ) {

			h.light.visible = true;
			h.light.intensity = h.baseIntensity * intensityScale * 2.5;
			h.light.distance = h.baseDistance * s * 1.4;

		} else {

			h.light.intensity = h.baseIntensity * intensityScale;
			h.light.distance = h.baseDistance * s;
			h.light.visible = vehicleLights._headlightsBeforeHighBeam;

		}

	} );

	if ( vehicleLights.headlightLenses ) {

		const lensOn = on || vehicleLights._headlightsBeforeHighBeam;
		vehicleLights.headlightLenses.forEach( ( lens ) => {

			lens.visible = lensOn;
			lens.scale.setScalar( on ? 1.3 : 1 );

		} );

	}

}

// Call every frame; handles the hazard blink timing and keeps light
// range proportional to the vehicle's current scale (AR resize control) —
// a light's `.distance` is in local units and does NOT automatically
// scale with its parent's transform the way position/rotation do.
//
// hazardScale: optional separate scale for hazards only, defaulting to
// `scale` when omitted. Needed because AR floating-track/arena pass a
// `scale` that already has AR_LIGHT_DAMPING baked in (added specifically
// because the headlights — baseIntensity 500 — were blindingly strong at
// close range in AR). Hazards start from a much weaker baseIntensity (3),
// so that same damping on top of AR's already-tiny FIXED_SCALE crushed
// them down to barely visible. Callers that want hazards undamped (i.e.
// scaled only by the real AR size, not the extra headlight-only factor)
// pass the undamped FIXED_SCALE here explicitly.
function updateVehicleLights( vehicleLights, dt, scale, isReversing = false, hazardScale = null ) {

	if ( ! vehicleLights ) return;

	// Every light's distance/intensity scales with the vehicle size —
	// not just headlights. Taillights are always-on, so at AR-tabletop
	// scale an unscaled ~0.9m range dwarfed the entire shrunk track,
	// washing the whole scene in red. Both distance and intensity scale
	// linearly with `scale` — matches how the same light would actually
	// look on a smaller physical car, and keeps brightness proportionate
	// to the AR track/arena rather than blowing it out.
	const s = Math.max( scale, 0.001 );
	const intensityScale = s;
	const hs = Math.max( hazardScale ?? scale, 0.001 );

	if ( vehicleLights.headlights ) {

		vehicleLights.headlights.forEach( ( h ) => {

			h.light.distance = h.baseDistance * s;
			h.light.intensity = h.baseIntensity * intensityScale;

		} );

	}

	if ( vehicleLights.taillights ) {

		vehicleLights.taillights.forEach( ( t ) => {

			t.light.distance = t.baseDistance * s;
			t.light.intensity = t.baseIntensity * intensityScale;

		} );

	}

	if ( vehicleLights.hazards ) {

		vehicleLights.hazards.forEach( ( h ) => {

			h.light.distance = h.baseDistance * hs;
			h.light.intensity = h.baseIntensity * hs;

		} );

	}

	if ( vehicleLights.reverseLights ) {

		vehicleLights.reverseLights.forEach( ( r ) => {

			r.light.distance = r.baseDistance * s;
			r.light.intensity = r.baseIntensity * intensityScale;
			r.light.visible = isReversing;
			if ( r.lens ) r.lens.visible = isReversing;

		} );

	}

	if ( vehicleLights.hazardsOn ) {

		vehicleLights._blinkTimer = ( vehicleLights._blinkTimer || 0 ) + dt;
		const on = Math.floor( vehicleLights._blinkTimer / 0.4 ) % 2 === 0;
		vehicleLights.hazards.forEach( ( h ) => { h.light.visible = on; } );

	}

}

// ─── Race countdown ─────────────────────────────────────────

// TEMPORARY diagnostic helper — flashes a short-lived note in the
// corner of the screen. Used to get definitive visual proof the AI
// stuck-recovery watchdog actually fires (console.warn alone isn't
// visible on a phone). Safe to remove once the AI driving issue is
// confirmed fixed.
function flashDebugNote( text ) {

	const el = document.createElement( 'div' );
	el.textContent = text;
	el.style.cssText = `
		position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 80;
		background: rgba(20,10,30,0.85); color: #fff; padding: 8px 16px; border-radius: 10px;
		font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 13px; direction: rtl;
		border: 1px solid rgba(139,95,191,0.5);
	`;
	document.body.appendChild( el );
	setTimeout( () => el.remove(), 2500 );

}

function createCountdownUI() {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-countdown {
			position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
			pointer-events: none;
		}
		#hw-countdown .cd-num {
			font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 120px; font-weight: 800; color: #fff;
			text-shadow: 0 0 30px rgba(91,140,255,0.8), 0 4px 12px rgba(0,0,0,0.6);
		}
	`;
	document.head.appendChild( style );

	const el = document.createElement( 'div' );
	el.id = 'hw-countdown';
	el.innerHTML = '<div class="cd-num"></div>';
	document.body.appendChild( el );

	return {
		numEl: el.querySelector( '.cd-num' ),
		set( text ) {

			this.numEl.textContent = text;
			this.numEl.animate(
				[ { transform: 'scale(1.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 } ],
				{ duration: 280, easing: 'ease-out' }
			);

		},
		remove() { el.remove(); },
	};

}

// ─── Fullscreen toggle (web mode only — an AR session already takes
// over the whole display, see the comment at the AR entry button). ────
// requestFullscreenSafe() already fires once automatically when picking
// a web mode from the menu, but that single attempt can silently fail
// (some mobile browsers are stricter about what counts as a "direct
// enough" gesture) or get backed out of later (OS gesture, alt-tab,
// notification pull-down) with no way back in — this is a persistent
// on-screen button so fullscreen can be (re)requested or exited at any
// point during play, not just once at the very start. Top-left corner:
// top-right is the lap timer's own corner (LapTimer.js), bottom-left is
// the radio dock below.
function setupFullscreenToggle() {

	// Same feature test as requestFullscreenSafe() — skip creating the
	// button at all on browsers with no Fullscreen API support (notably
	// iPhone Safari), since a button that could never do anything would
	// just be confusing clutter.
	const docEl = document.documentElement;
	const supported = !! ( docEl.requestFullscreen || docEl.webkitRequestFullscreen ||
		docEl.mozRequestFullScreen || docEl.msRequestFullscreen );
	if ( ! supported ) return;

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-fullscreen-btn {
			position: fixed; left: 14px; top: 14px; z-index: 30;
			width: 46px; height: 46px; border-radius: 50%; border: none; padding: 0;
			display: flex; align-items: center; justify-content: center;
			font-size: 19px; color: #fff;
			background: linear-gradient(165deg, rgba(32,20,54,0.72), rgba(13,13,22,0.72));
			border: 1px solid rgba(139,95,191,0.35);
			backdrop-filter: blur(6px);
			box-shadow: 0 6px 24px rgba(0,0,0,0.4);
			touch-action: manipulation; transition: background 0.12s, transform 0.08s;
		}
		#hw-fullscreen-btn:active {
			background: linear-gradient(135deg, #8B5FBF, #5B8CFF);
			transform: scale(0.94);
		}
	`;
	document.head.appendChild( style );

	const btn = document.createElement( 'button' );
	btn.id = 'hw-fullscreen-btn';
	document.body.appendChild( btn );

	function sync() {

		btn.textContent = isFullscreenActive() ? '✕' : '⛶';
		btn.title = isFullscreenActive() ? 'الخروج من ملء الشاشة' : 'ملء الشاشة';

	}

	// pointerdown (not click), same as the radio dock's own buttons: lower
	// latency, and stopPropagation keeps the tap from also registering as
	// a steering-zone touch (Controls.js's steer-zone covers the whole
	// screen underneath this button).
	btn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		if ( isFullscreenActive() ) exitFullscreenSafe();
		else requestFullscreenSafe();

	} );

	[ 'fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange' ]
		.forEach( ( evt ) => document.addEventListener( evt, sync ) );

	sync();

}

// ─── Touch radio controls (phones/tablets — no keyboard, no VR hands) ──
// Controls.js already covers a full-screen invisible steering zone for
// touch, so these buttons need a higher z-index to receive taps first.

function setupRadioTouchUI( radio, vehicleLights ) {

	if ( ! ( 'ontouchstart' in window ) ) return { highBeamHeld: false };

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-touch-dock {
			position: fixed; left: 14px; bottom: 14px; z-index: 30;
			display: flex; flex-direction: column; gap: 8px;
			padding: 10px 8px; border-radius: 20px;
			background: linear-gradient(165deg, rgba(32,20,54,0.72), rgba(13,13,22,0.72));
			border: 1px solid rgba(139,95,191,0.35);
			backdrop-filter: blur(6px);
			box-shadow: 0 6px 24px rgba(0,0,0,0.4);
		}
		#hw-touch-dock button {
			width: 50px; height: 50px; border-radius: 50%; border: none; padding: 0;
			background: rgba(255,255,255,0.06); color: #fff; font-size: 21px;
			display: flex; align-items: center; justify-content: center;
			touch-action: manipulation; transition: background 0.12s, transform 0.08s;
		}
		#hw-touch-dock button:active {
			background: linear-gradient(135deg, #8B5FBF, #5B8CFF);
			transform: scale(0.94);
		}
	`;
	document.head.appendChild( style );

	const wrap = document.createElement( 'div' );
	wrap.id = 'hw-touch-dock';

	function makeTapButton( label ) {

		const btn = document.createElement( 'button' );
		btn.textContent = label;
		return btn;

	}

	const nextBtn = makeTapButton( '⏭' );
	const toggleBtn = makeTapButton( '⏯' );
	const headlightBtn = makeTapButton( '💡' );
	const hazardBtn = makeTapButton( '⚠️' );
	const highBeamBtn = makeTapButton( '🔆' );

	// pointerdown (not click) for lower latency and to match the steering
	// zone's own event type; stopPropagation so the tap doesn't also get
	// picked up as a steering-zone touch.
	nextBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		stopBgMusic();
		radio.next();

	} );
	toggleBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		stopBgMusic();
		radio.togglePlayPause();

	} );
	headlightBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		toggleHeadlights( vehicleLights );

	} );
	hazardBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		toggleHazards( vehicleLights );

	} );
	// High beam is a hold, not a tap — on while pressed, off on release.
	// Sets a flag rather than calling setHighBeam() directly: the
	// keyboard's own per-frame check (N key) was calling setHighBeam()
	// unconditionally every frame regardless of source, so on a
	// touch-only device (no keyboard) that per-frame call was always
	// "off" and immediately canceled whatever this button had just
	// turned on. The frame loop now combines both sources before calling
	// setHighBeam() once.
	const touchState = { highBeamHeld: false };
	highBeamBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		touchState.highBeamHeld = true;

	} );
	[ 'pointerup', 'pointerleave', 'pointercancel' ].forEach( ( evt ) => {

		highBeamBtn.addEventListener( evt, ( e ) => {

			e.stopPropagation();
			touchState.highBeamHeld = false;

		} );

	} );

	wrap.appendChild( nextBtn );
	wrap.appendChild( toggleBtn );
	wrap.appendChild( headlightBtn );
	wrap.appendChild( hazardBtn );
	wrap.appendChild( highBeamBtn );
	document.body.appendChild( wrap );

	return touchState;

}

// ─── Shared physics world setup (used by both modes) ──────

function createPhysicsWorld( gravityScale = 1 ) {

	const worldSettings = createWorldSettings();
	worldSettings.gravity = [ 0, - 9.81 * gravityScale, 0 ];

	// crashcat's own distance-based tolerances (speculative-contact
	// radius, allowed penetration slop, sleep-velocity threshold, …)
	// default to values tuned for roughly real-world-sized objects —
	// e.g. a 2cm penetrationSlop/speculativeContactDistance and a
	// 3cm/s sleep threshold. Both AR floating modes call this with
	// gravityScale = arTransform.scale (≈0.016), spawning a car whose
	// own radius shrinks to under a centimeter — smaller than those
	// default tolerances. The result: the car can rest half-buried in
	// the track/floor (penetrationSlop bigger than the whole car) and
	// gets treated as "at rest" and put to sleep almost immediately
	// (its whole achievable speed range sits under the 3cm/s sleep
	// threshold), which is exactly the "floating/sunk, then doesn't
	// move at all" symptom. Scaling every one of these by the same
	// factor keeps them proportional to the (also scaled) car instead
	// of proportional to a real-world car, and is a no-op at
	// gravityScale = 1 (every NORMAL-mode caller), so nothing changes
	// there.
	if ( gravityScale !== 1 ) {

		worldSettings.narrowphase.speculativeContactDistance *= gravityScale;
		worldSettings.narrowphase.manifoldTolerance *= gravityScale;
		worldSettings.contacts.contactPointPreserveLambdaMaxDistSq *= gravityScale * gravityScale;
		worldSettings.solver.penetrationSlop *= gravityScale;
		worldSettings.solver.maxPenetrationDistance *= gravityScale;
		worldSettings.sleeping.pointVelocitySleepThreshold *= gravityScale;

	}

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

	const { world, vehicle, particles, driftMarks, audio, lapTimer, contactListener, vehicleFlag } = ctx;

	updateWorld( world, contactListener, dt );
	vehicle.update( dt, input );

	particles.update( dt, vehicle );
	driftMarks.update( dt, vehicle );
	audio.update( dt, vehicle.linearSpeed / MAX_SPEED, input.z, vehicle.driftIntensity, vehicle.linearSpeed < -0.01 );
	if ( vehicle.justLaunched ) audio.playLaunch();
	if ( vehicleFlag ) vehicleFlag.updateFlutter( dt, Math.abs( vehicle.linearSpeed / MAX_SPEED ) );

	if ( lapTimer ) {

		const hasInput = input.touchActive || Math.abs( input.x ) > 0.05 || Math.abs( input.z ) > 0.05;
		lapTimer.update( dt, vehicle.spherePos, hasInput );

	}

}

// ─── AI opponents (real Vehicle physics, same as the player) ──
// Each AI gets its own Vehicle + sphere rigid body — the exact same
// class and physics the player drives with (sphere collider, suspension
// lean, wheel spin, drift). Steering/throttle are computed each frame
// from the direction to the next waypoint and fed in using the same
// "touch" input shape the game already uses for world-space-direction
// joystick control (see Controls.js/Vehicle.js), so movement quality
// matches the player's car and auto-gas naturally targets MAX_SPEED —
// giving genuinely competitive AI without extra speed tuning.

const TOTAL_RACE_LAPS = 3; // matches LapTimer.js's own TOTAL_LAPS

// Computes a 2-wide staggered starting grid behind the finish line —
// slot 0 is the player (front-left), slots 1+ are AI opponents.
function computeGridPositions( vehicleSpawn, count ) {

	const { position, angle } = vehicleSpawn;
	// Matches Vehicle.js's own forward-vector convention (see the same
	// note in Track.js's computeTrackPath) — NOT flipped. With the old
	// flipped vector, "position - forward*backDist" actually placed
	// slots AHEAD of the finish line (opposite of this function's own
	// "behind the finish line" comment) since -forward*backDist canceled
	// the flip back to +trueForward*backDist.
	const forward = { x: Math.sin( angle ), z: Math.cos( angle ) };
	const right = { x: forward.z, z: - forward.x };
	const rowSpacing = 3.2, colOffset = 0.8;

	const slots = [];
	for ( let i = 0; i < count; i ++ ) {

		const row = Math.floor( i / 2 );
		const col = ( i % 2 === 0 ) ? -1 : 1;
		const backDist = 2 + row * rowSpacing;

		const x = position[ 0 ] - forward.x * backDist + right.x * col * colOffset;
		const z = position[ 2 ] - forward.z * backDist + right.z * col * colOffset;

		slots.push( { position: [ x, position[ 1 ], z ], angle, backDist } );

	}

	return slots;

}

function createAIDrivers( npcConfigs, gridSlots, models, scene, world, path, radius = 0.5 ) {

	if ( ! path || path.length < 2 ) return [];

	// Average spacing between consecutive path points — used to convert
	// each grid slot's "how far back from the line" distance directly
	// into a starting path index, counting backward from index 0 (the
	// finish line). This avoids a plain nearest-point spatial search,
	// which could pick a point on the wrong side of the loop where the
	// start and end come back close together near the finish line,
	// sending that car off in the wrong direction from the start.
	let totalLen = 0;
	for ( let j = 0; j < path.length; j ++ ) {

		const a = path[ j ], b = path[ ( j + 1 ) % path.length ];
		totalLen += Math.hypot( b.x - a.x, b.z - a.z );

	}
	const avgSpacing = totalLen / path.length;

	return npcConfigs.map( ( cfg, i ) => {

		const slot = gridSlots[ i + 1 ]; // slot 0 is the player
		const sphereBody = createSphereBody( world, slot.position, radius );

		const vehicle = new Vehicle();
		vehicle.sphereRadius = radius;
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.set( slot.position[ 0 ], slot.position[ 1 ], slot.position[ 2 ] );
		vehicle.prevModelPos.set( slot.position[ 0 ], 0, slot.position[ 2 ] );
		vehicle.container.rotation.y = slot.angle;

		const model = models[ cfg.key ] || models[ 'vehicle-truck-yellow' ];
		const group = vehicle.init( model );
		group.scale.setScalar( radius / 0.5 ); // matches the player's own visual scale — 1 for NORMAL mode (radius=0.5), shrunk in AR contexts
		scene.add( group );

		const stepsBack = Math.round( slot.backDist / avgSpacing );
		const bestIdx = ( ( path.length - stepsBack ) % path.length + path.length ) % path.length;

		return {
			vehicle, idx: bestIdx,
			lapsCompleted: 0,
			finished: false,
			finishTime: null,
			stuckStrikes: 0,
			sampleTimer: 0,
			samplePos: { x: slot.position[ 0 ], z: slot.position[ 2 ] },
		};

	} );

}

// ─── Free-roam AI (random wandering "تفحيط" show, no fixed path) ──
// Unlike the race AI above, these don't follow a track — they just pick
// a random point inside the open arena, drive at it aggressively (full
// throttle, no easing off for the turn — the opposite of the race AI's
// cornering behavior), and pick a new random point every few seconds.
// The sharp steering at speed naturally induces the same drift the
// player's own car gets from Vehicle.js's physics, giving a "تفحيط
// show" look. No collision avoidance — bumping the boundary wall or
// another car is fine, even expected, for this look.

// roadHalfZ defaults to roadHalf so existing (square) callers spread AI
// exactly as before; a rectangular arena passes both independently so the
// spawn ring matches its actual footprint instead of a circle inscribed
// inside the shorter side.
function createFreeRoamAI( npcConfigs, models, scene, world, roadHalf, roadHalfZ = roadHalf ) {

	// Widened alongside updateFreeRoamAIDrivers' own wanderRadius (see
	// AIController.js) — these AI cars now spread across most of the
	// arena's radius from the start instead of clustering near its
	// center.
	const spawnMarginX = roadHalf * 0.85; // keep starting points away from the walls
	const spawnMarginZ = roadHalfZ * 0.85;

	return npcConfigs.map( ( cfg, i ) => {

		const angle = ( i / npcConfigs.length ) * Math.PI * 2;
		const distFrac = 0.3 + Math.random() * 0.65;
		const x = Math.cos( angle ) * spawnMarginX * distFrac;
		const z = Math.sin( angle ) * spawnMarginZ * distFrac;
		const heading = Math.random() * Math.PI * 2;

		const sphereBody = createSphereBody( world, [ x, 0.5, z ] );

		const vehicle = new Vehicle();
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spherePos.set( x, 0.5, z );
		vehicle.prevModelPos.set( x, 0, z );
		vehicle.container.rotation.y = heading;

		const model = models[ cfg.key ] || models[ 'vehicle-truck-yellow' ];
		const group = vehicle.init( model );
		scene.add( group );

		return {
			vehicle,
			target: { x, z }, // reached immediately, forces a fresh pick on frame 1
			retargetTimer: 0,
			stuckStrikes: 0,
			sampleTimer: 0,
			samplePos: { x, z },
		};

	} );

}


// Ranks player + AI by laps completed (then in-lap progress as a
// tiebreak) — used once the player finishes to produce final standings.
function computeStandings( drivers, path, playerFinishTime ) {

	const entries = [ {
		label: 'أنت', isPlayer: true,
		metric: TOTAL_RACE_LAPS,
		finishTime: playerFinishTime,
	} ];

	drivers.forEach( ( d, i ) => {

		const progress = path && path.length > 1 ? d.idx / path.length : 0;
		entries.push( {
			label: 'المتسابق ' + ( i + 1 ), isPlayer: false,
			metric: d.lapsCompleted + progress,
			finishTime: d.finishTime,
		} );

	} );

	entries.sort( ( a, b ) => {

		if ( a.finishTime !== null && b.finishTime !== null ) return a.finishTime - b.finishTime;
		if ( a.finishTime !== null ) return -1;
		if ( b.finishTime !== null ) return 1;
		return b.metric - a.metric;

	} );

	return entries;

}

function showRaceResultsOverlay( standings, { onRestart, onMenu } ) {

	const style = document.createElement( 'style' );
	style.textContent = `
		#hw-race-results {
			position: fixed; inset: 0; z-index: 55; display: flex; align-items: center; justify-content: center;
			background: rgba(5,5,10,0.78); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
		}
		#hw-race-results .rr-card {
			max-width: 400px; width: 90%; padding: 28px 24px; border-radius: 20px; text-align: center;
			background: radial-gradient(circle at 50% 0%, #201436 0%, #0d0d16 70%);
			border: 1px solid rgba(139,95,191,0.4); box-shadow: 0 0 50px rgba(91,60,140,0.25);
		}
		#hw-race-results .rr-title {
			font-size: 26px; font-weight: 800; margin-bottom: 18px;
			background: linear-gradient(90deg, #8B5FBF 0%, #5B8CFF 50%, #4FD8E8 100%);
			-webkit-background-clip: text; background-clip: text; color: transparent;
		}
		#hw-race-results .rr-row {
			display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-top: 1px solid rgba(255,255,255,0.08);
		}
		#hw-race-results .rr-row:first-of-type { border-top: none; }
		#hw-race-results .rr-pos { width: 26px; font-weight: 800; color: #9d8fd4; }
		#hw-race-results .rr-label { flex: 1; text-align: right; color: #fff; font-size: 14.5px; }
		#hw-race-results .rr-row.rr-me .rr-label { color: #5B8CFF; font-weight: 700; }
		#hw-race-results .rr-btns { display: flex; gap: 10px; margin-top: 20px; }
		#hw-race-results button {
			flex: 1; padding: 13px; border: none; border-radius: 999px; font-size: 14.5px; font-weight: 600; cursor: pointer;
		}
		#hw-race-results .rr-restart { background: linear-gradient(90deg, #8B5FBF, #5B8CFF); color: #fff; }
		#hw-race-results .rr-menu { background: rgba(255,255,255,0.08); color: #cfc9e0; }
	`;
	document.head.appendChild( style );

	const overlay = document.createElement( 'div' );
	overlay.id = 'hw-race-results';
	overlay.dir = 'rtl';
	overlay.innerHTML = `
		<div class="rr-card">
			<div class="rr-title">🏁 نتيجة السباق</div>
			${ standings.map( ( s, i ) => `
				<div class="rr-row ${ s.isPlayer ? 'rr-me' : '' }">
					<div class="rr-pos">${ i + 1 }</div>
					<div class="rr-label">${ s.label }</div>
				</div>
			` ).join( '' ) }
			<div class="rr-btns">
				<button class="rr-restart">إعادة السباق</button>
				<button class="rr-menu">الصفحة الرئيسية</button>
			</div>
		</div>
	`;
	document.body.appendChild( overlay );

	overlay.querySelector( '.rr-restart' ).addEventListener( 'click', () => { overlay.remove(); onRestart(); } );
	overlay.querySelector( '.rr-menu' ).addEventListener( 'click', () => { overlay.remove(); onMenu(); } );

}

// AI cars in web mode originally had no flag, lights, or drift marks at
// all. addVehicleLights() was wired in for all of them, but it builds a
// FULL light rig per car — 2 headlight spotlights + 2 lens glows + 2
// taillights + 2 reverse lights + 4 hazards, 10 lights total — and
// nothing ever toggles headlights/high-beam/reverse for an AI car, so 6
// of those 10 were dead weight just sitting in the scene graph, still
// costing the renderer a light slot every frame, for 3-4 AI cars at
// once. That's the likely cause of the reported heaviness/stutter on
// the web-mode track. What was actually asked for was the flag and the
// hazard/emergency lights ("العلم وإضاءات الطوارئ") — so headlights,
// their lens glows, taillights, and reverse lights are removed from the
// scene graph right after creation, keeping only the 4 hazard lights
// live. `addVehicleLights` itself is left untouched (still used by the
// player's own car, and by AR mode which legitimately wants the full
// rig) — this only strips the extra Object3Ds back out for AI-in-web.
//
// Also adds the drift/tire marks AI cars were still missing in web mode
// (present already in AR). A finite lifetime (fades after a few
// seconds) is used rather than web mode's usual Infinity+localStorage
// persistence — that persistent-trail-record feature is specifically
// about the player's own driving history, not meant to grow 3-4 more
// permanently-saved trails every session for cars nobody is steering.
function setupWebAIExtras( aiDrivers, idPrefix ) {

	const aiFlagUrl = createSaudiFlagDataUrl();
	const AI_DRIFT_MARK_LIFETIME = 4;

	return aiDrivers.map( ( d, i ) => {

		const group = d.vehicle.container;

		const lights = addVehicleLights( group );
		lights.hazardsOn = true;
		lights.headlights.forEach( ( h ) => { h.light.removeFromParent(); h.target.removeFromParent(); } );
		lights.headlightLenses.forEach( ( lens ) => lens.removeFromParent() );
		lights.taillights.forEach( ( t ) => t.light.removeFromParent() );
		lights.reverseLights.forEach( ( r ) => { r.light.removeFromParent(); r.lens.removeFromParent(); } );

		const flag = addVehicleFlag( group, aiFlagUrl );
		const driftMarks = new DriftMarks( scene, idPrefix + '-' + i, 1, AI_DRIFT_MARK_LIFETIME );

		return { lights, flag, driftMarks };

	} );

}

// ─── NORMAL MODE (unchanged behavior from the original game) ──

function startNormalMode( { customCells, spawn, mapParam, customText, freeRoam, vehicleKey, flagImage } ) {

	const world = createPhysicsWorld();
	let sphereBody, vehicleSpawn, lapTimer = null;
	let trackPath = null, aiDrivers = [], aiExtras = [];
	let freeRoamHalf = 0;

	if ( freeRoam ) {

		// Open sandbox: no track, no walls — just a big flat ground.
		const groundSize = 110;

		// Night stadium look (matching a real "تفحيط" show — dark sky,
		// the floodlight poles below doing the actual lighting instead of
		// flat daylight). Scoped to free-roam only; the classic track
		// mode keeps its normal daylight scene.
		scene.background = new THREE.Color( 0x05060a );

		// A visible moon — otherwise the night sky was just a flat dark
		// color with no light source anyone could actually see, which
		// read as pure darkness rather than "night arena lit by
		// floodlights". Positioned far away and high up, unlit itself
		// (MeshBasicMaterial) so it reads as a glowing disc.
		const moon = new THREE.Mesh(
			new THREE.SphereGeometry( 6, 24, 24 ),
			new THREE.MeshBasicMaterial( { color: 0xe8ecf7 } )
		);
		moon.position.set( - groundSize * 0.6, groundSize * 0.5, - groundSize * 0.7 );
		scene.add( moon );
		scene.fog.color.set( 0x05060a );
		dirLight.intensity = 0.7; // moonlight fill, floodlights carry most of the scene
		hemiLight.intensity = 0.55;

		const roadHalf = groundSize / 2;

		const shadowExtent = roadHalf;
		dirLight.shadow.camera.left = - shadowExtent;
		dirLight.shadow.camera.right = shadowExtent;
		dirLight.shadow.camera.top = shadowExtent;
		dirLight.shadow.camera.bottom = - shadowExtent;
		dirLight.shadow.camera.updateProjectionMatrix();

		scene.fog.near = groundSize * 0.5;
		scene.fog.far = groundSize * 1.1;

		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ 0, - 0.125, 0 ],
			friction: 5.0,
			restitution: 0.0,
		} );

		// Visible asphalt ground, matching the invisible physics floor.
		const asphaltTexture = createAsphaltTexture();
		asphaltTexture.repeat.set( groundSize / 8, groundSize / 8 );
		const groundMesh = new THREE.Mesh(
			new THREE.PlaneGeometry( groundSize, groundSize ),
			new THREE.MeshStandardMaterial( { map: asphaltTexture, roughness: 1, metalness: 0 } )
		);
		groundMesh.rotation.x = - Math.PI / 2;
		groundMesh.position.set( 0, - 0.12, 0 );
		groundMesh.receiveShadow = true;
		scene.add( groundMesh );

		// Solid perimeter walls so the car bounces off the edge instead of
		// driving past it and falling into the void — now with visible
		// grandstands (crowd included, Reem-circuit style) instead of an
		// invisible boundary.
		const wallHalfHeight = 1.0;
		const wallThickness = 0.2;
		const wallY = - 0.125 + wallHalfHeight;

		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( world, { // north/south (along X)
				shape: box.create( { halfExtents: [ roadHalf, wallHalfHeight, wallThickness ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ 0, wallY, sign * roadHalf ],
				friction: 0.2,
				restitution: 0.3,
			} );

			rigidBody.create( world, { // east/west (along Z)
				shape: box.create( { halfExtents: [ wallThickness, wallHalfHeight, roadHalf ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ sign * roadHalf, wallY, 0 ],
				friction: 0.2,
				restitution: 0.3,
			} );

		}

		// Same red/white barrier style as the actual race track (and the
		// AR floating arena) instead of grandstands — keeps the visual
		// language consistent across web/AR and both arena variants.
		buildBarrierLoop( scene, null, roadHalf, roadHalf, - 0.125 );

		// Floodlight poles at the four corners, all aimed back at center —
		// the actual light source for the night-stadium look set above.
		const poleInset = roadHalf * 0.82;
		for ( const cx of [ -1, 1 ] ) {

			for ( const cz of [ -1, 1 ] ) {

				buildFloodlightPole( scene, cx * poleInset, cz * poleInset, { x: 0, z: 0 }, world );

			}

		}

		// Dry desert surround, peeking out beyond the paved arena's edge —
		// sits just below the asphalt so it only shows past its footprint.
		const sandTexture = createSandTexture();
		const sandSize = groundSize * 2;
		sandTexture.repeat.set( sandSize / 10, sandSize / 10 );
		const sandMesh = new THREE.Mesh(
			new THREE.PlaneGeometry( sandSize, sandSize ),
			new THREE.MeshStandardMaterial( { map: sandTexture, roughness: 1, metalness: 0 } )
		);
		sandMesh.rotation.x = - Math.PI / 2;
		sandMesh.position.set( 0, - 0.121, 0 );
		sandMesh.receiveShadow = true;
		scene.add( sandMesh );

		// Burnout circles + drift trails, baked once across the whole
		// paved surface — a proper tiled texture would look obviously
		// repeated at this scale.
		const skidMarksTexture = createSkidMarksTexture( groundSize );
		const skidOverlay = new THREE.Mesh(
			new THREE.PlaneGeometry( groundSize, groundSize ),
			new THREE.MeshStandardMaterial( {
				map: skidMarksTexture, transparent: true, roughness: 1,
				metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
			} )
		);
		skidOverlay.rotation.x = - Math.PI / 2;
		skidOverlay.position.set( 0, - 0.1195, 0 );
		scene.add( skidOverlay );

		// Racing curb (white edge line + red rumble-strip blocks), same
		// style as the actual race track, traced just inside this arena's
		// own barrier loop.
		const edgeTexture = createTrackEdgeTexture( groundSize, groundSize, roadHalf, roadHalf );
		const edgeOverlay = new THREE.Mesh(
			new THREE.PlaneGeometry( groundSize, groundSize ),
			new THREE.MeshStandardMaterial( {
				map: edgeTexture, transparent: true, roughness: 0.9,
				metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
			} )
		);
		edgeOverlay.rotation.x = - Math.PI / 2;
		edgeOverlay.position.set( 0, - 0.119, 0 );
		scene.add( edgeOverlay );

		// Concrete barriers dressing the same line as the invisible
		// collision walls above (no extra physics needed — the collider's
		// already there). One gap left open on the +Z side for the
		// entrance gate.
		const barrierSeg = 8;
		for ( const sign of [ 1, -1 ] ) {

			for ( let p = - roadHalf; p < roadHalf; p += barrierSeg ) {

				const segLen = Math.min( barrierSeg, roadHalf - p ) - 0.3; // small gaps between segments, like real jersey barrier sections
				if ( segLen <= 0 ) continue;
				const center = p + segLen / 2;

				// Leave the entrance gate gap on the north wall (+Z, sign=1, axis 'x')
				if ( sign === 1 && Math.abs( center ) < 3 ) continue;

				buildBarrierSegment( scene, null, center, sign * roadHalf, segLen, 'x' );
				buildBarrierSegment( scene, null, sign * roadHalf, center, segLen, 'z' );

			}

		}

		buildEntranceGate( scene, 0, roadHalf, 'x' );

		// Tire stacks + parked decoration cars scattered near all 4
		// corners (randomized each time), warning signs flanking the gate.
		scatterCornerDecor( scene, models, roadHalf, roadHalf, [ 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red' ], world );
		buildWarningSign( scene, -4.5, roadHalf - 1, Math.PI );
		buildWarningSign( scene, 4.5, roadHalf - 1, Math.PI );

		// All 4 vehicle models wander/drift here — unlike the race grid
		// (which reserves yellow for the player by default and uses the
		// other 3 for AI), free-roam has no such reservation.
		aiDrivers = createFreeRoamAI(
			[ { key: 'vehicle-truck-yellow' }, ...NPC_TRUCKS.map( ( [ key ] ) => ( { key } ) ) ],
			models, scene, world, roadHalf
		);
		freeRoamHalf = roadHalf;

		aiExtras = setupWebAIExtras( aiDrivers, 'web-freeroam-ai' );

		vehicleSpawn = { position: [ 0, 0.5, 0 ], angle: 0 };
		sphereBody = createSphereBody( world, vehicleSpawn.position );

	} else {

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

		const { npcConfigs } = buildTrack( scene, models, customCells );
		trackPath = computeTrackPath( customCells );

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

		// Starting grid: player at the front, AI staggered behind —
		// instead of the player spawning exactly on the line.
		let gridSpawn = spawn;
		if ( spawn && npcConfigs.length > 0 ) {

			const gridSlots = computeGridPositions( spawn, 1 + npcConfigs.length );
			gridSpawn = gridSlots[ 0 ];
			aiDrivers = createAIDrivers( npcConfigs, gridSlots, models, scene, world, trackPath );
			aiExtras = setupWebAIExtras( aiDrivers, 'web-race-ai' );

		}

		vehicleSpawn = gridSpawn;
		sphereBody = createSphereBody( world, gridSpawn ? gridSpawn.position : null );
		lapTimer = new LapTimer( customCells, mapParam );

	}

	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;

	if ( vehicleSpawn ) {

		const [ sx, sy, sz ] = vehicleSpawn.position;
		vehicle.spherePos.set( sx, sy, sz );
		vehicle.prevModelPos.set( sx, 0, sz );
		vehicle.container.rotation.y = vehicleSpawn.angle;

	}

	const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
	scene.add( vehicleGroup );
	addCustomTextDecals( vehicleGroup, customText );
	const vehicleLights = addVehicleLights( vehicleGroup );
	// flagImage comes from the main menu's image picker (a data: URL, see
	// createModeMenu) — falls back to the placeholder banner in Flag.js
	// if the player didn't pick one.
	const vehicleFlag = addVehicleFlag( vehicleGroup, flagImage );

	dirLight.target = vehicleGroup;

	const cam = new Camera();
	scene.add( cam.debug );

	const controls = new Controls();

	const particles = new SmokeTrails( scene );
	// AI cars share ONE dedicated, deliberately light smoke emitter — same
	// idea as the AR floating-track/arena fix that stopped the smoke
	// freeze (real-world scale here, so scale stays 1, only emitMultiplier
	// is cut) — separate from the player's own full-strength `particles`
	// so AI stays a light background effect rather than competing with it.
	const aiParticles = new SmokeTrails( scene, 1, 0.15 );
	const driftMarks = new DriftMarks( scene, mapParam );

	const audio = new GameAudio();
	audio.init( cam.camera, vehicleGroup );

	const radio = new Radio( audio.listener, vehicleGroup );
	const touchState = setupRadioTouchUI( radio, vehicleLights );
	setupFullscreenToggle();

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

	const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer, contactListener, vehicleFlag };

	// Radio controls for NORMAL mode (no VR controllers here, so keyboard
	// instead): R = next track, T = play/pause. L = headlights, H =
	// hazards. Edge-detected so holding a key doesn't rapid-fire.
	let prevKeys = { r: false, t: false, l: false, h: false };

	// Race start countdown — only for an actual track with a finish line
	// (not free-roam). Controls stay locked until it reaches zero.
	const isRace = !! ( lapTimer && lapTimer.enabled );
	const raceState = { phase: isRace ? 'countdown' : 'racing', countdown: 3, countdownTimer: 0, totalTime: 0 };
	let countdownUI = isRace ? createCountdownUI() : null;
	if ( countdownUI ) countdownUI.set( String( raceState.countdown ) );
	let resultsShown = false;

	if ( isRace ) {

		lapTimer.onFinish = () => { raceState.phase = 'finished'; };

	}

	return {

		frameUpdate( dt ) {

			if ( raceState.phase === 'countdown' ) {

				raceState.countdownTimer += dt;
				if ( raceState.countdownTimer >= 1 ) {

					raceState.countdownTimer -= 1;
					raceState.countdown -= 1;

					if ( raceState.countdown > 0 ) {

						countdownUI.set( String( raceState.countdown ) );

					} else {

						countdownUI.set( 'GO!' );
						raceState.phase = 'racing';
						setTimeout( () => { if ( countdownUI ) { countdownUI.remove(); countdownUI = null; } }, 500 );

					}

				}

			} else if ( raceState.phase !== 'countdown' ) {

				// Keep advancing after the player finishes too (phase
				// 'finished'), not just during 'racing' — see the
				// aiRacing note below for why this must not freeze.
				raceState.totalTime += dt;

			}

			const racing = raceState.phase === 'racing';
			const rawInput = controls.update();
			const input = racing ? rawInput : { x: 0, z: 0, touchActive: false };

			updateVehicleAndFx( dt, input, ctx );
			if ( isRace ) {

				// IMPORTANT: do NOT gate the AI update on `racing`. The
				// player's own LapTimer can (and often does) finish their
				// 3 laps before slower AI drivers finish theirs — `racing`
				// flips to false the instant raceState.phase becomes
				// 'finished', which zeroes every AI driver's input and
				// freezes it wherever it happens to be (looked like "AI
				// stops after 2 laps" whenever the player finished first).
				// Each AI already stops itself once IT personally reaches
				// TOTAL_RACE_LAPS (d.finished, checked inside
				// updateRaceAIDrivers) — so only the pre-race countdown
				// should hold them back, not the player crossing the line.
				const aiRacing = raceState.phase !== 'countdown';
				updateRaceAIDrivers( aiDrivers, trackPath, dt, aiRacing, raceState.totalTime, vehicle );

			} else {

				updateFreeRoamAIDrivers( aiDrivers, dt, freeRoamHalf );

			}

			// AI cars' hazard-blink timing, flag flutter, and drift/tire
			// marks — same per-frame update the player's own car gets, just
			// applied to each AI car's own { lights, flag, driftMarks }
			// from aiExtras above.
			for ( let i = 0; i < aiDrivers.length; i ++ ) {

				const extra = aiExtras[ i ];
				if ( ! extra ) continue;
				const d = aiDrivers[ i ];
				updateVehicleLights( extra.lights, dt, 1, d.vehicle.linearSpeed < -0.01 );
				if ( extra.flag ) extra.flag.updateFlutter( dt, Math.abs( d.vehicle.linearSpeed / MAX_SPEED ) );
				if ( extra.driftMarks ) extra.driftMarks.update( dt, d.vehicle );
				aiParticles.update( dt, d.vehicle );

			}

			updateVehicleLights( vehicleLights, dt, 1, vehicle.linearSpeed < -0.01 );

			if ( raceState.phase === 'finished' && ! resultsShown ) {

				resultsShown = true;
				const standings = computeStandings( aiDrivers, trackPath, raceState.totalTime );
				showRaceResultsOverlay( standings, {
					onRestart: () => {

						// Stash this race's settings so init() can skip the mode
						// menu on reload and jump straight back into the same
						// race/track/car. See the matching read+consume logic
						// near the top of init() (sessionStorage key 'hwRestartRace').
						try {

							sessionStorage.setItem( 'hwRestartRace', JSON.stringify( { customText, freeRoam, vehicleKey, flagImage } ) );

						} catch ( e ) { /* ignore — falls back to showing the menu again */ }
						location.reload();

					},
					onMenu: () => { location.href = location.pathname; },
				} );

			}

			const rKey = !! controls.keys[ 'KeyR' ];
			const tKey = !! controls.keys[ 'KeyT' ];
			const lKey = !! controls.keys[ 'KeyL' ];
			const hKey = !! controls.keys[ 'KeyH' ];
			const nKey = !! controls.keys[ 'KeyN' ];
			if ( rKey && ! prevKeys.r ) { stopBgMusic(); radio.next(); }
			if ( tKey && ! prevKeys.t ) { stopBgMusic(); radio.togglePlayPause(); }
			if ( lKey && ! prevKeys.l ) toggleHeadlights( vehicleLights );
			if ( hKey && ! prevKeys.h ) toggleHazards( vehicleLights );
			setHighBeam( vehicleLights, nKey || touchState.highBeamHeld );
			audio.setHorn( !! controls.keys[ 'Space' ] );
			prevKeys = { r: rKey, t: tKey, l: lKey, h: hKey };

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

// Stage 2 test: a plain placeholder box you can grab, move, and resize
// in AR — proving out the shared mechanic (PlaceableObject.js) before
// it's used for the real floating track/arena. Deliberately skips
// ARManager's own hit-test floor-placement flow entirely (no session
// requiredFeature for it either) since this test doesn't need a floor,
// just controller tracking + passthrough, both of which ARManager's
// constructor/requestSession already set up.
async function startARPlaceableTest( { sessionPromise } ) {

	const arManager = new ARManager( { renderer, scene, models } );
	await arManager.requestSession( sessionPromise );
	arManager.previewGroup.visible = false; // not using hit-test placement here

	const placeholderCamera = new THREE.PerspectiveCamera();

	const box = new THREE.Mesh(
		new THREE.BoxGeometry( 0.3, 0.15, 0.4 ),
		new THREE.MeshStandardMaterial( { color: 0x5B8CFF, roughness: 0.4, metalness: 0.2 } )
	);
	// Roughly a meter in front of, and slightly below, wherever the
	// headset happens to be when the session starts — simplest possible
	// starting point for a grab-test; the real track placement will
	// need proper hit-test/preview like the existing room-drive AR mode.
	box.position.set( 0, 0.9, - 0.8 );
	scene.add( box );

	const light = new THREE.DirectionalLight( 0xffffff, 2 );
	light.position.set( 1, 2, 1 );
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.6 ) );

	const placeable = new PlaceableObject( box, arManager );
	placeable.onConfirm = () => {

		box.material.color.set( 0x5af168 ); // turns green once locked, so it's obvious the confirm worked

	};

	return {

		frameUpdate( dt ) {

			try {

				placeable.update( dt );

			} catch ( e ) {

				console.error( '[main] PlaceableObject test update() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

// ─── AR floating track (Stage 3) ────────────────────────────
// The default track, built exactly like NORMAL mode, but grabbable/
// movable/scalable (PlaceableObject, same mechanic proven in Stage 2)
// instead of fixed in place. No AI opponents yet — single car, kept
// simple for this first working version.
//
// Physics note: crashcat's rigid bodies live in absolute world space,
// completely disconnected from a THREE.Object3D's own transform — so a
// real physics car wouldn't follow the track being grabbed/moved/resized
// at all. Instead the car is a plain child of trackGroup with simple
// kinematic movement (position/heading updated directly, no rigid body),
// entirely in the group's local space — Three.js's normal parent-child
// transform inheritance then makes it automatically move/scale with the
// track for free, no extra bookkeeping needed. It trades away momentum/
// suspension/drift physics for correctness under a moving reference
// frame; can revisit if that trade turns out to matter in practice.
// ─── Kinematic AI (no physics — for the floating track/arena, ──
// ─── where crashcat's world-space rigid bodies can't follow    ──
// ─── a grabbable/scalable parent group's own transform)        ──
// Same path-following/lookahead-steering math as the web version's
// updateAIDrivers(), just operating on plain {x,z,heading,speed} state
// instead of a Vehicle+rigidBody, and parented under the track/arena
// group so movement is automatically correct after a grab or resize.

function createKinematicTrackAI( npcConfigs, gridSlots, models, parentGroup, path ) {

	if ( ! path || path.length < 2 ) return [];

	let totalLen = 0;
	for ( let j = 0; j < path.length; j ++ ) {

		const a = path[ j ], b = path[ ( j + 1 ) % path.length ];
		totalLen += Math.hypot( b.x - a.x, b.z - a.z );

	}
	const avgSpacing = totalLen / path.length;

	return npcConfigs.map( ( cfg, i ) => {

		const slot = gridSlots[ i + 1 ]; // slot 0 is the player
		const model = ( models[ cfg.key ] || models[ 'vehicle-truck-yellow' ] ).clone();
		model.traverse( ( c ) => { if ( c.isMesh ) { c.castShadow = false; c.receiveShadow = false; } } );
		model.position.set( slot.position[ 0 ], slot.position[ 1 ], slot.position[ 2 ] );
		model.rotation.y = slot.angle;
		parentGroup.add( model );

		const stepsBack = Math.round( slot.backDist / avgSpacing );
		const idx = ( ( path.length - stepsBack ) % path.length + path.length ) % path.length;

		return {
			model, idx,
			x: slot.position[ 0 ], z: slot.position[ 2 ], heading: slot.angle, speed: 0,
			y: slot.position[ 1 ],
		};

	} );

}

function updateKinematicTrackAI( drivers, path, dt, racing ) {

	if ( ! path || path.length < 2 ) return;

	const LOOKAHEAD = 2;
	const MAX_SPEED = 8, ACCEL = 10, TURN_RATE = 3;

	for ( const d of drivers ) {

		if ( ! racing ) continue;

		const target = path[ ( d.idx + 1 ) % path.length ];
		const dx0 = target.x - d.x, dz0 = target.z - d.z;
		if ( Math.hypot( dx0, dz0 ) < 1.0 ) d.idx = ( d.idx + 1 ) % path.length;

		const lookaheadPoint = path[ ( d.idx + LOOKAHEAD ) % path.length ];
		const dx = lookaheadPoint.x - d.x, dz = lookaheadPoint.z - d.z;
		const dist = Math.hypot( dx, dz );

		let targetSpeed = MAX_SPEED;
		if ( dist > 0.001 ) {

			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - d.heading;
			// Wrap to (-PI, PI]. NOTE: `((x+PI)%(2*PI))-PI` alone is
			// broken in JavaScript for x below -PI, because JS `%` keeps
			// the sign of the dividend (unlike e.g. Python's modulo) —
			// see the normalizeAngle() comment in AIController.js for the
			// full writeup and a real-physics repro. The extra
			// `+2*PI)%(2*PI)` forces a non-negative intermediate first.
			angleDiff = ( ( ( angleDiff + Math.PI ) % ( Math.PI * 2 ) + Math.PI * 2 ) % ( Math.PI * 2 ) ) - Math.PI;

			d.heading += THREE.MathUtils.clamp( angleDiff, - TURN_RATE * dt, TURN_RATE * dt );

			const sharpness = THREE.MathUtils.clamp( Math.abs( angleDiff ) / ( Math.PI / 3 ), 0, 1 );
			targetSpeed = MAX_SPEED * ( 1 - sharpness * 0.5 );

		}

		d.speed += THREE.MathUtils.clamp( targetSpeed - d.speed, - ACCEL * dt, ACCEL * dt );
		d.x += Math.sin( d.heading ) * d.speed * dt;
		d.z += Math.cos( d.heading ) * d.speed * dt;

		d.model.position.set( d.x, d.y, d.z );
		d.model.rotation.y = d.heading;

	}

}

// ─── AR floating 3D mode menu ───────────────────────────────
// Shown immediately on entering AR — three pointable/selectable cards
// (room-drive / floating track / floating arena), replacing the old
// flat pre-session sub-screen. Selection uses controller pointing
// (raycasting, the natural VR/AR menu interaction) + trigger to
// confirm, rather than the grab mechanic PlaceableObject uses
// elsewhere (grabbing implies "pick this up", which doesn't fit
// "choose one of these options").
const modeCardLoader = new THREE.TextureLoader();
const modeCardFallbackColors = { room: '#5B8CFF', track: '#8B5FBF', arena: '#E0621B' };
const modeCardTextures = {};
for ( const key of [ 'room', 'track', 'arena' ] ) {

	modeCardTextures[ key ] = modeCardLoader.load(
		`models/Textures/mode-${ key }.jpeg`,
		( t ) => { t.colorSpace = THREE.SRGBColorSpace; },
		undefined,
		( err ) => console.error( `[main] mode card texture failed to load: mode-${ key }.jpeg`, err )
	);

}

function createModeCard( textureKey ) {

	// Portrait aspect ratio matching the source images (≈469:768) —
	// title text is already baked into the image itself, so no canvas
	// text overlay needed here.
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry( 0.22, 0.36 ),
		new THREE.MeshBasicMaterial( { map: modeCardTextures[ textureKey ], side: THREE.DoubleSide } )
	);

	return mesh;

}

// Returns a Promise resolving to 'room' | 'track' | 'arena'.
function showFloatingModeMenu( arManager, scene ) {

	return new Promise( ( resolve ) => {

		const options = [ 'room', 'track', 'arena' ];

		const menuGroup = new THREE.Group();
		scene.add( menuGroup );

		const cards = options.map( ( id, i ) => {

			const card = createModeCard( id );
			card.position.set( ( i - 1 ) * 0.26, 0, 0 );
			card.userData.optionId = id;
			card.userData.baseScale = 1;
			menuGroup.add( card );
			return card;

		} );

		const light = new THREE.PointLight( 0xffffff, 2, 3 );
		scene.add( light );

		// Eye-level follow: a fixed y=1.2 read as "too high" or "too low"
		// depending on the person's actual height/posture, since it had
		// nothing to do with where their headset actually was. Recomputed
		// every frame from the real XR camera pose instead — position.y
		// matches real eye height exactly, x/z sit a fixed distance ahead
		// along the camera's current horizontal facing (pitch/roll from
		// looking up/down ignored, so the panel stays upright rather than
		// tilting with the headset), and lookAt (menu and camera at the
		// same y) naturally comes out level with no extra tilt math needed.
		const _mmCamPos = new THREE.Vector3();
		const _mmCamQuat = new THREE.Quaternion();
		const _mmFwd = new THREE.Vector3();
		function followEyeLevel( dt ) {

			const cam = renderer.xr.getCamera();
			cam.getWorldPosition( _mmCamPos );
			cam.getWorldQuaternion( _mmCamQuat );
			_mmFwd.set( 0, 0, -1 ).applyQuaternion( _mmCamQuat );
			_mmFwd.y = 0;
			if ( _mmFwd.lengthSq() < 1e-6 ) _mmFwd.set( 0, 0, -1 );
			_mmFwd.normalize();

			menuGroup.position.set( _mmCamPos.x + _mmFwd.x * 0.8, _mmCamPos.y, _mmCamPos.z + _mmFwd.z * 0.8 );
			menuGroup.lookAt( _mmCamPos.x, _mmCamPos.y, _mmCamPos.z );

			light.position.set( _mmCamPos.x + _mmFwd.x * 0.5, _mmCamPos.y, _mmCamPos.z + _mmFwd.z * 0.5 );

		}

		const raycaster = new THREE.Raycaster();
		const tmpDir = new THREE.Vector3();
		const prevTrigger = { left: false, right: false };
		let resolved = false;

		function cleanup() {

			scene.remove( menuGroup );
			scene.remove( light );

		}

		this._floatingMenuUpdate = ( dt ) => {

			if ( resolved ) return;

			followEyeLevel( dt );

			let hoveredCard = null;

			for ( const hand of [ 'left', 'right' ] ) {

				const controller = arManager.controllers[ hand ];
				const gp = arManager.gamepads[ hand ];
				if ( ! controller || ! gp ) continue;

				tmpDir.set( 0, 0, - 1 ).applyQuaternion( controller.quaternion );
				raycaster.set( controller.position, tmpDir );
				const hits = raycaster.intersectObjects( cards );

				const trig = gp.buttons[ 0 ] ? gp.buttons[ 0 ].pressed : false;
				const trigEdge = trig && ! prevTrigger[ hand ];
				prevTrigger[ hand ] = trig;

				if ( hits.length > 0 ) {

					hoveredCard = hits[ 0 ].object;
					if ( trigEdge ) {

						resolved = true;
						cleanup();
						resolve( hoveredCard.userData.optionId );
						return;

					}

				}

			}

			cards.forEach( ( c ) => {

				const targetScale = ( c === hoveredCard ) ? 1.15 : 1;
				c.scale.setScalar( THREE.MathUtils.lerp( c.scale.x, targetScale, Math.min( 1, dt * 10 ) ) );

			} );

		};

	} );

}

// ─── AR entry orchestrator ──────────────────────────────────
// One session is requested here (with hit-test available for all three
// modes, even though only room-drive currently uses it — simpler than
// branching the session's requiredFeatures before the person has even
// picked a mode). The floating 3D menu runs first; once they choose,
// control hands off to whichever mode's own start function, reusing
// this same connected arManager instead of each opening its own session.
//
// Returns its frameUpdate wrapper immediately (not after the person has
// chosen) — the main loop only calls frameUpdate on whatever this
// function already returned, so waiting on the menu's choice here
// first would mean nothing ever drives the menu's own per-frame
// update, and the choice would never come.
// Simple two-card confirm shown when the Menu button is pressed —
// "رجوع لأوضاع AR" ends the current AR sub-mode (track/arena/room) and
// returns to the AR track/arena/room picker, NOT the game's main
// pre-AR menu (see openExitConfirm's hwReturnToArMenu stash in
// startARWithFloatingMenu); "إلغاء" just dismisses. Reuses the same
// pointing+trigger interaction as the mode-selection menu.
function showExitConfirm( arManager, scene ) {

	return new Promise( ( resolve ) => {

		const group = new THREE.Group();
		scene.add( group );

		// Same eye-level follow as showFloatingModeMenu above — see its
		// comment for why a fixed y=1.2 was wrong.
		const _ecCamPos = new THREE.Vector3();
		const _ecCamQuat = new THREE.Quaternion();
		const _ecFwd = new THREE.Vector3();
		function followEyeLevel() {

			const cam = renderer.xr.getCamera();
			cam.getWorldPosition( _ecCamPos );
			cam.getWorldQuaternion( _ecCamQuat );
			_ecFwd.set( 0, 0, -1 ).applyQuaternion( _ecCamQuat );
			_ecFwd.y = 0;
			if ( _ecFwd.lengthSq() < 1e-6 ) _ecFwd.set( 0, 0, -1 );
			_ecFwd.normalize();

			group.position.set( _ecCamPos.x + _ecFwd.x * 0.6, _ecCamPos.y, _ecCamPos.z + _ecFwd.z * 0.6 );
			group.lookAt( _ecCamPos.x, _ecCamPos.y, _ecCamPos.z );

		}

		function makeCard( text, color ) {

			const canvas = document.createElement( 'canvas' );
			canvas.width = 512; canvas.height = 200;
			const ctx = canvas.getContext( '2d' );
			ctx.fillStyle = color;
			ctx.fillRect( 0, 0, 512, 200 );
			ctx.fillStyle = '#fff';
			ctx.font = 'bold 44px "Segoe UI", Tahoma, Arial, sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.direction = 'rtl';
			ctx.fillText( text, 256, 100 );
			const texture = new THREE.CanvasTexture( canvas );
			texture.colorSpace = THREE.SRGBColorSpace;
			return new THREE.Mesh(
				new THREE.PlaneGeometry( 0.26, 0.1 ),
				new THREE.MeshBasicMaterial( { map: texture, side: THREE.DoubleSide } )
			);

		}

		const exitCard = makeCard( 'رجوع لأوضاع AR', '#C0392B' );
		exitCard.position.set( - 0.15, 0, 0 );
		exitCard.userData.action = 'exit';
		const cancelCard = makeCard( 'إلغاء', '#3A3A40' );
		cancelCard.position.set( 0.15, 0, 0 );
		cancelCard.userData.action = 'cancel';
		group.add( exitCard, cancelCard );

		const cards = [ exitCard, cancelCard ];
		const raycaster = new THREE.Raycaster();
		const tmpDir = new THREE.Vector3();
		const prevTrigger = { left: false, right: false };
		let resolved = false;

		function update( dt ) {

			if ( resolved ) return;

			followEyeLevel();

			let hovered = null;

			for ( const hand of [ 'left', 'right' ] ) {

				const controller = arManager.controllers[ hand ];
				const gp = arManager.gamepads[ hand ];
				if ( ! controller || ! gp ) continue;

				tmpDir.set( 0, 0, - 1 ).applyQuaternion( controller.quaternion );
				raycaster.set( controller.position, tmpDir );
				const hits = raycaster.intersectObjects( cards );

				const trig = gp.buttons[ 0 ] ? gp.buttons[ 0 ].pressed : false;
				const trigEdge = trig && ! prevTrigger[ hand ];
				prevTrigger[ hand ] = trig;

				if ( hits.length > 0 ) {

					hovered = hits[ 0 ].object;
					if ( trigEdge ) {

						resolved = true;
						scene.remove( group );
						resolve( hovered.userData.action );
						return;

					}

				}

			}

			cards.forEach( ( c ) => {

				const target = ( c === hovered ) ? 1.15 : 1;
				c.scale.setScalar( THREE.MathUtils.lerp( c.scale.x, target, Math.min( 1, dt * 10 ) ) );

			} );

		}

		showExitConfirm._update = update;

	} );

}

// Small persistent floating icon, always available during any AR mode —
// a genuine alternative to the physical Menu button, which turned out
// unreachable via WebXR on the browsers tested (reserved by the system
// for its own menu). Positioned low and off to one side so it doesn't
// sit in the middle of the view, but still reachable by pointing at it.
function createFloatingHomeButton( scene ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 200; canvas.height = 200;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#2a2a30';
	ctx.beginPath();
	ctx.arc( 100, 100, 96, 0, Math.PI * 2 );
	ctx.fill();
	ctx.strokeStyle = 'rgba(255,255,255,0.6)';
	ctx.lineWidth = 4;
	ctx.stroke();
	// Simple house icon
	ctx.strokeStyle = '#fff';
	ctx.lineWidth = 10;
	ctx.lineJoin = 'round';
	ctx.beginPath();
	ctx.moveTo( 60, 105 ); ctx.lineTo( 100, 70 ); ctx.lineTo( 140, 105 );
	ctx.stroke();
	ctx.strokeRect( 72, 100, 56, 45 );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;

	const button = new THREE.Mesh(
		new THREE.CircleGeometry( 0.055, 24 ),
		new THREE.MeshBasicMaterial( { map: texture, transparent: true, side: THREE.DoubleSide } )
	);
	button.position.set( - 0.35, 0.9, - 0.6 );
	scene.add( button );

	return button;

}

async function startARWithFloatingMenu( { mapParam, customText, vehicleKey, flagImage, sessionPromise } ) {

	const arManager = new ARManager( { renderer, scene, models } );
	await arManager.requestSession( sessionPromise );

	// Bloom is authored for a single flat camera and doesn't handle
	// WebXR's per-eye stereo rendering correctly — also directly
	// responsible for bright lights blowing out into an overwhelming
	// glow, since bloom amplifies bright pixels heavily.
	renderer.setEffects( [] );
	arManager.session.addEventListener( 'end', () => { renderer.setEffects( [ bloomPass ] ); } );

	const placeholderCamera = new THREE.PerspectiveCamera();
	const menuCtx = {};
	const choicePromise = showFloatingModeMenu.call( menuCtx, arManager, scene );

	let subMode = null; // set once the chosen mode's own async setup resolves
	let switching = false;
	let exitConfirmActive = false;

	// Persistent floating home button — created now but only checked for
	// interaction once actually driving (subMode set), since the mode
	// menu and exit-confirm already have their own dedicated flows.
	const homeButton = createFloatingHomeButton( scene );
	let homeButtonDwell = 0;
	const HOME_BUTTON_RANGE = 0.1;
	const HOME_BUTTON_DWELL_TIME = 0.4; // seconds of holding a controller near it

	choicePromise.then( async ( chosenId ) => {

		switching = true;

		try {

			if ( chosenId === 'track' ) {

				subMode = await startARFloatingTrack( { arManager, vehicleKey, customText, flagImage } );

			} else if ( chosenId === 'arena' ) {

				subMode = await startARFloatingArena( { arManager, vehicleKey, customText, flagImage } );

			} else {

				subMode = await startARMode( { arManager, mapParam, customText, vehicleKey, flagImage } );

			}

		} catch ( e ) {

			console.error( '[main] AR mode setup after floating menu failed:', e );

		}

	} );

	function openExitConfirm() {

		exitConfirmActive = true;
		showExitConfirm( arManager, scene ).then( ( action ) => {

			exitConfirmActive = false;
			if ( action === 'exit' ) {

				// A full reload rather than just session.end() — the
				// game has no existing teardown path for its internal
				// state (physics world, vehicle, audio, etc.) once an
				// AR mode is active, so a bare session end would leave
				// activeMode pointing at now-defunct XR objects. This
				// is the same "start clean" pattern every mode
				// transition already relies on.
				//
				// Stashed here (same sessionStorage-handoff pattern as
				// "إعادة السباق") so init() can skip the FULL main menu
				// after reload and land back on the AR track/arena/room
				// picker instead — this button is "back to the AR modes",
				// not "back to the game's very first screen". A fresh
				// user gesture is still required to re-request a WebXR
				// session (browsers won't allow that automatically after
				// a reload), so init() shows one small "re-enter AR"
				// button rather than skipping straight back in.
				try {

					sessionStorage.setItem( 'hwReturnToArMenu', JSON.stringify( { customText, vehicleKey, flagImage } ) );

				} catch ( e ) { /* ignore */ }

				arManager.session.end().finally( () => window.location.reload() );

			}

		} );

	}

	return {

		frameUpdate( dt, timestamp, frame ) {

			// Menu (☰) button — see getMenuButtonPress()'s own comment on
			// why this may simply never fire depending on the browser.
			if ( ! exitConfirmActive && arManager.getMenuButtonPress() ) openExitConfirm();

			// Floating home button — proximity + a short dwell time
			// (no button press needed) rather than pointing+trigger,
			// since trigger/grip are already claimed by throttle/horn
			// during driving and would otherwise fire both at once.
			// Repositioned every frame relative to the headset (like a
			// HUD element) — a fixed world position could end up out of
			// comfortable reach if the person moved around the room
			// after it was first placed.
			if ( ! exitConfirmActive && subMode ) {

				const cam = renderer.xr.getCamera();
				const camPos = new THREE.Vector3();
				const camQuat = new THREE.Quaternion();
				cam.getWorldPosition( camPos );
				cam.getWorldQuaternion( camQuat );
				const offset = new THREE.Vector3( -0.25, -0.15, -0.5 ).applyQuaternion( camQuat );
				homeButton.position.copy( camPos ).add( offset );
				homeButton.quaternion.copy( camQuat );

				let near = false;
				for ( const hand of [ 'left', 'right' ] ) {

					const controller = arManager.controllers[ hand ];
					if ( controller && controller.position.distanceTo( homeButton.position ) <= HOME_BUTTON_RANGE ) near = true;

				}

				if ( near ) {

					homeButtonDwell += dt;
					const t = Math.min( 1, homeButtonDwell / HOME_BUTTON_DWELL_TIME );
					homeButton.scale.setScalar( 1 + t * 0.3 );
					if ( homeButton.material ) homeButton.material.opacity = 0.6 + t * 0.4;
					if ( homeButtonDwell >= HOME_BUTTON_DWELL_TIME ) {

						homeButtonDwell = 0;
						homeButton.scale.setScalar( 1 );
						openExitConfirm();

					}

				} else {

					homeButtonDwell = 0;
					homeButton.scale.setScalar( 1 );
					if ( homeButton.material ) homeButton.material.opacity = 0.85;

				}

			}

			if ( exitConfirmActive ) {

				if ( showExitConfirm._update ) showExitConfirm._update( dt );
				renderer.render( scene, placeholderCamera );
				return;

			}

			if ( subMode ) {

				subMode.frameUpdate( dt, timestamp, frame );
				return;

			}

			if ( ! switching && menuCtx._floatingMenuUpdate ) menuCtx._floatingMenuUpdate( dt );
			renderer.render( scene, placeholderCamera );

		}

	};

}

async function startARFloatingTrack( { arManager, vehicleKey, customText, flagImage } ) {

	// STAGE 1 (placement) + STAGE 2 (rebuild): place + lock the track,
	// then spawn a full-featured real-physics car on it — same feature
	// set as room-drive AR mode (lights, flag, text, smoke, drift marks,
	// audio, radio, horn), just at the track's fixed AR scale instead of
	// a user-resizable one.
	// Hit-test IS used (see the placing phase in frameUpdate below, via
	// arManager.updateExternalPlacement()) — just not ARManager's own
	// generic ring/arrow previewGroup, since the actual track itself
	// (arRoot) is the preview here.
	arManager.previewGroup.visible = false;

	const placeholderCamera = new THREE.PerspectiveCamera();
	const { trackGroup, npcConfigs } = buildTrack( scene, models, null, { skipDeco: true } );
	const spawn = computeSpawnPosition( null );
	const bounds = computeTrackBounds( TRACK_CELLS );
	const trackPath = computeTrackPath( null );
	let totalTime = 0;

	// ✏️ EASY RETUNING KNOBS — both are purely cosmetic/pacing, safe to
	// tweak freely without touching physics stability (mass, gravity, and
	// the real 0.5m collision radius are never touched by either of
	// them):
	//  - FIXED_SCALE: how big the whole tabletop track appears (smaller
	//    number = smaller footprint on the table). This is now the ONLY
	//    size knob — a previous per-car CAR_VISUAL_BOOST hack (rendering
	//    the car's model bigger than its real hitbox) was removed after
	//    feedback that it made car sizes inconsistent: the player car,
	//    the AI cars (boosted the same way), and the arena's own parked
	//    decoration cars (never boosted, since they're not "the car" —
	//    just static dressing) all ended up at three different relative
	//    sizes on the same tabletop. Every car-shaped object here — the
	//    player, the AI racers, and the decoration cars in the arena's
	//    corners — is now rendered at its real, unboosted, 1:1 size, and
	//    ALL of them are parented under the one wrapping transform group
	//    (arRoot / arenaGroup) that FIXED_SCALE is applied to. That
	//    guarantees every car on the table shares the exact same
	//    proportions relative to the track/arena and to each other,
	//    which is exactly how NORMAL/web mode already works — this is
	//    that same approach, not a new one.
	//  - TIME_SCALE: the actual fix for "the car feels slow" — a real
	//    car driven at real speed, shrunk to fit on a table but viewed
	//    from the player's own REAL (unshrunk) eye distance, is a
	//    textbook "miniature effect": the same physical motion covers a
	//    proportionally tiny slice of your field of view, so it reads as
	//    slow-motion no matter how fast the physics itself says the car
	//    is going — the car's true speed never changed, only how far
	//    away it looks from being shrunk. This is the same reasoning
	//    film miniature work uses in reverse (full-size scenes shot to
	//    look tiny are sped up so they read as toy-scale) — here it's
	//    already toy-scale, so simulation TIME itself is sped up instead
	//    to make it read as full-speed again. Applied only to the
	//    physics/AI/particle updates below (see simDt), never to input
	//    reading or blink timers, so controls/UI still feel responsive
	//    at a normal rate.
	// Bumped up (0.02 → 0.026, ~30%) per feedback that the car should read
	// a bit bigger — this is the ONE shared knob (see the CAR_VISUAL_BOOST
	// removal note above): it scales arRoot as a whole, so car, track,
	// and every decoration piece all grow together, keeping their
	// relative proportions exactly as they were instead of just the car
	// alone getting bigger (which is what caused the original car/AI/
	// decoration size-mismatch bug this session started by fixing).
	const FIXED_SCALE = 0.026;
	// Reset to the game's base speed (1 = identical pacing to NORMAL/web
	// mode) — an earlier 2.5x was tuned to fix a reported "feels slow"
	// issue at very small AR scale, but overshot and read as sped-up.
	const TIME_SCALE = 1;
	// How long (seconds) a tire/drift mark stays on the ground before
	// fading out — much shorter than NORMAL mode's permanent record,
	// since the user reported marks lingering too long in AR.
	const DRIFT_MARK_LIFETIME = 4;
	// Extra headlight dimming specific to this AR mode, on top of
	// FIXED_SCALE's own size-based scaling. updateVehicleLights()/
	// setHighBeam() scale a light's distance AND intensity linearly by
	// whatever `scale` they're given, but physically-based inverse-square
	// falloff (decay=2 on the SpotLight itself, see addVehicleLights()'s
	// baseIntensity comment) means brightness right next to the source
	// stays extreme regardless of that scale — and the AR track is viewed
	// from real, close-up distance, unlike NORMAL/web mode's own headlight
	// use where the car is far from camera. Feedback was specifically
	// that headlights stayed too strong here even after the shared
	// baseIntensity cut (which mainly fixed web mode, since web's scale=1
	// applies no reduction at all) — this multiplies FIXED_SCALE down
	// further, ONLY for this mode's lights (raceCtx.arScale below is used
	// exclusively for lighting, nothing else, so it's safe to bake the
	// extra factor directly into it here).
	const AR_LIGHT_DAMPING = 0.35;

	// arRoot carries the AR placement (position/rotation/scale) as one
	// clean transform. trackGroup goes underneath it UNCHANGED — still
	// carrying buildTrack()'s own internal position.y=-0.5 and
	// scale=GRID_SCALE(0.75), which is what aligns its child pieces
	// with the wall/ground physics formulas in the first place (those
	// formulas already bake in that same -0.5/0.75 as absolute NORMAL-
	// mode coordinates). Overwriting trackGroup's own transform instead
	// of wrapping it was fighting that baseline on two fronts at once —
	// scale (fixed previously) and Y-position (this fix): mixing MY
	// arbitrary AR position into the same transform as that internal
	// -0.5 pushed the visual track's Y out of sync with where the wall/
	// ground colliders (which assume that -0.5 stays exactly as-authored)
	// actually ended up.
	const arRoot = new THREE.Group();
	scene.add( arRoot );
	arRoot.add( trackGroup );

	// Position/rotation are no longer a fixed guess — see the placing-
	// phase in frameUpdate below, which drives arRoot from the same
	// real-surface hit-test the room-drive AR mode uses (ARManager's
	// updateExternalPlacement()), so the track lands on an actual
	// detected table/floor instead of floating at a hardcoded distance.
	// Hidden until the first surface hit lands.
	arRoot.scale.setScalar( FIXED_SCALE );
	arRoot.visible = false;

	const light = new THREE.DirectionalLight( 0xffffff, 3 );
	light.position.set( 0.6, 1, 0.6 );
	light.castShadow = true;
	// Shadow camera frustum sized to the track's small AR footprint
	// (span ≈ 60 × FIXED_SCALE meters) — the default frustum is tuned
	// for NORMAL mode's much larger real-scale track and was far too
	// wide here, making shadow resolution effectively zero.
	const shadowExtent = 60 * GRID_SCALE * FIXED_SCALE;
	light.shadow.camera.left = - shadowExtent;
	light.shadow.camera.right = shadowExtent;
	light.shadow.camera.top = shadowExtent;
	light.shadow.camera.bottom = - shadowExtent;
	light.shadow.camera.near = 0.1;
	light.shadow.camera.far = shadowExtent * 4;
	light.shadow.mapSize.setScalar( 1024 );
	light.shadow.camera.updateProjectionMatrix();
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.6 ) );

	// dirLight (module-level, top of file) is created once at page load
	// and stays castShadow=true forever — nothing ever turned it back off
	// for this mode. So this scene was rendering TWO full shadow-casting
	// directional lights every single frame: dirLight (4096×4096 map,
	// still using its NORMAL-mode shadow frustum since only startNormalMode
	// ever calls dirLight.shadow.camera.left/right/top/bottom) stacked on
	// top of this mode's own purpose-built `light` above. A second full
	// shadow-map render pass every frame is real, avoidable GPU cost —
	// exactly the kind of thing that pushes frame time past a Quest's
	// ~11ms/frame budget and shows up as the reprojection judder/shake
	// reported when turning your head after locking the track in. `light`
	// + the ambient above are the actual intended lighting for this tiny
	// AR scene, so dirLight is switched off entirely here rather than
	// just its shadow — it was also double-lighting the scene from a
	// second directional source at full (3) intensity. Page reload on
	// exit (see the exit handler below) restores it for the next mode.
	dirLight.visible = false;

	let raceCtx = null;
	let confirmed = false;

	function lockInTrack() {

		try {

			// Track stays exactly where/how big it is from this point on —
			// real physics colliders are built to match THIS transform once
			// (crashcat's rigid bodies live in absolute world space, not
			// arRoot's own transform, so they'd desync from any further
			// grab — which is why resize/move are locked at this stage).
			// Physics now runs at REAL scale — the exact same numbers as
			// NORMAL/web mode (real 9.81 gravity, real 0.5m car radius,
			// real track dimensions), instead of the previous approach of
			// shrinking the whole physics simulation down to tabletop
			// size. A millimeter-scale rigid-body sim fights crashcat's
			// own distance tolerances (collision margins, sleep
			// thresholds) and Vehicle.js's own driving-feel constants
			// (suspension, grip, drift thresholds) — both tuned in
			// real-world units — which is what caused the reported "car
			// behaves oddly" symptom (floating/sinking, jitter, erratic
			// handling), even after earlier attempts to patch around it by
			// scaling those tolerances down too (see createPhysicsWorld's
			// own comment). `arRoot` already does the one thing actually
			// needed for the AR "tabletop" look — a pure VISUAL
			// scale+placement transform — so simulating underneath it at
			// full scale and simply parenting the car under `arRoot` (see
			// vehicleGroup below) lets three.js handle the shrink
			// automatically, with no manual coordinate scaling anywhere in
			// this function — exactly how NORMAL mode's own track/car
			// coordinates already work, just wrapped in one extra parent
			// transform for placement.
			const world = createPhysicsWorld();
			buildWallColliders( world, null, null );

			// Same ground-collider sizing as NORMAL mode's own track
			// branch (see startNormalMode): padded well beyond the track's
			// own footprint so the car can't drive off the edge into the
			// void.
			const groundSize = Math.max( bounds.halfWidth, bounds.halfDepth ) * 2 + 20;
			const roadHalf = groundSize / 2;
			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: [ bounds.centerX, - 0.125, bounds.centerZ ],
				friction: 5.0,
				restitution: 0.0,
			} );

			// Real 0.5m car radius — createSphereBody's own NORMAL-mode
			// default, no AR-specific scaling. Full grid (player + AI
			// opponents), same layout NORMAL mode's own track branch uses.
			const gridSlots = computeGridPositions( spawn, 1 + npcConfigs.length );
			const gridSlot = gridSlots[ 0 ];
			const sphereBody = createSphereBody( world, gridSlot.position );

			const vehicle = new Vehicle();
			vehicle.rigidBody = sphereBody;
			vehicle.physicsWorld = world;
			vehicle.spawnPos = gridSlot.position;
			vehicle.spawnAngle = gridSlot.angle;
			vehicle.spherePos.set( gridSlot.position[ 0 ], gridSlot.position[ 1 ], gridSlot.position[ 2 ] );
			vehicle.prevModelPos.set( gridSlot.position[ 0 ], 0, gridSlot.position[ 2 ] );
			vehicle.container.rotation.y = gridSlot.angle;

			const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
			// Parented under arRoot (not scene) — vehicle.container.position
			// is set directly from spherePos each frame (see Vehicle.js),
			// which is now in the SAME real-scale "track-local" coordinate
			// system trackGroup's own pieces already use underneath arRoot.
			// arRoot's own scale+placement transform therefore shrinks and
			// places the car exactly in sync with the track, automatically,
			// every frame — no per-spawn or per-frame coordinate transform
			// needed at all.
			arRoot.add( vehicleGroup );
			addCustomTextDecals( vehicleGroup, customText );
			const vehicleLights = addVehicleLights( vehicleGroup );
			const vehicleFlag = addVehicleFlag( vehicleGroup, flagImage );

			const audio = new GameAudio();
			audio.init( renderer.xr.getCamera(), vehicleGroup );
			audio.forceUnlock();
			const radio = new Radio( audio.listener, vehicleGroup );

			// Smoke IS scaled for AR (going back to the game's plain default
			// caused the reported freeze/hang before the track even fully
			// rendered) — Particles.js authors particle size in real
			// world-first meters (BASE_SIZE=1), and these particles are
			// added straight to `scene` rather than nested under `arRoot`,
			// so at scale=1 each puff rendered close to a full meter wide —
			// several times bigger than the whole (FIXED_SCALE-shrunk) car.
			// Passing FIXED_SCALE * 0.7 here keeps every puff visibly
			// smaller than the car, proportional to it instead of dwarfing
			// it. emitMultiplier is also cut hard (0.15, well below the
			// previous 0.3) since this ONE particle pool is shared across
			// the player AND all 3 AI every frame (see the AI loop below) —
			// four cars all emitting into the same fixed-size pool at
			// default emission rate is exactly what caused the freeze.
			const particles = new SmokeTrails( scene, FIXED_SCALE * 0.7, 0.15 );
			// AI now gets its own separate, even-lighter pool instead of
			// sharing the player's — per feedback that AI smoke should be
			// lighter everywhere. Splitting it out also removes the AI cars'
			// share of load from the player's own pool.
			const aiParticles = new SmokeTrails( scene, FIXED_SCALE * 0.7, 0.06 );
			// Drift marks fade out after DRIFT_MARK_LIFETIME seconds instead
			// of staying forever — appropriate for AR (a live tabletop
			// scene, not a persisted record like NORMAL mode's track), and
			// also skips the localStorage persistence NORMAL mode relies on
			// (a faded mark has no age info, so it would come back at full
			// strength on reload otherwise). NORMAL/room-AR mode's own
			// DriftMarks calls are untouched — they keep the default
			// Infinity lifetime and their permanent saved record.
			const driftMarks = new DriftMarks( scene, 'ar-floating-track', FIXED_SCALE, DRIFT_MARK_LIFETIME );

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

			const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer: null, contactListener, vehicleFlag };

			// AI opponents — the exact same real Vehicle physics as the
			// player (createAIDrivers is NORMAL mode's own function,
			// reused unchanged), parented under arRoot (passed in place of
			// `scene`) so they shrink/place in sync automatically exactly
			// like the player. No radius override now (defaults to the
			// real 0.5m / scale=1) — same reasoning as removing
			// CAR_VISUAL_BOOST above: AI cars stay the exact same real
			// size as the player and the arena's decoration cars, all
			// governed by the one FIXED_SCALE transform.
			const aiDrivers = createAIDrivers( npcConfigs, gridSlots, models, arRoot, world, trackPath );
			// AI flags always fly this fixed Saudi Arabia flag — never the
			// player's own flagImage — and don't change if the player
			// changes theirs. Flutter is driven every frame below (AI
			// flags were previously created but never animated — only the
			// player's own updateVehicleAndFx() call did that).
			const aiFlagUrl = createSaudiFlagDataUrl();
			const aiExtras = aiDrivers.map( ( d, i ) => {

				const group = d.vehicle.container;
				const lights = addVehicleLights( group );
				lights.hazardsOn = true; // AI always shows hazard/emergency blinkers
				const flag = addVehicleFlag( group, aiFlagUrl );
				const marks = new DriftMarks( scene, 'ar-floating-track-ai-' + i, FIXED_SCALE, DRIFT_MARK_LIFETIME );
				return { lights, driftMarks: marks, flag };

			} );

			raceCtx = { world, vehicle, vehicleGroup, vehicleLights, audio, radio, ctx, aiDrivers, aiExtras, aiParticles, arScale: FIXED_SCALE * AR_LIGHT_DAMPING };

		} catch ( e ) {

			console.error( '[main] floating-track lock-in failed:', e );
			showErrorOverlay(
				( e && e.message ) ? e.message : String( e ),
				e && e.stack ? e.stack : '',
				() => window.location.reload(),
				'تعذّر تثبيت المضمار — السيارة لم تُنشأ'
			);

		}

	}

	const controls = new Controls();

	return {

		frameUpdate( dt, timestamp, frame ) {

			try {

				if ( ! confirmed ) {

					// Same hit-test surface search + thumbstick nudge + trigger
					// confirm as the room-drive AR mode's own placement screen
					// (ARManager.updateExternalPlacement — see its comment) —
					// the track stays hidden and glued to the camera's search
					// until a real surface (table, floor, …) is found, then
					// follows that surface (with thumbstick fine-adjustment)
					// until the trigger is pulled.
					const { hasHit, confirmEdge } = arManager.updateExternalPlacement( frame, dt );

					arRoot.visible = hasHit;

					if ( hasHit ) {

						// hit-test gives "which way is away from the player, on
						// the detected surface" as arQuaternion — spawn.angle is
						// then composed on top (a further LOCAL yaw) so the
						// track's own start gate still faces the same relative
						// direction it always has, exactly like the previous
						// fixed `rotation.y = spawn.angle` did, just now applied
						// on top of a real detected surface pose instead of a
						// guessed fixed one.
						arRoot.position.copy( arManager.arPosition );
						arRoot.quaternion.copy( arManager.arQuaternion );
						arRoot.rotateY( spawn.angle );

					}

					if ( confirmEdge ) {

						confirmed = true;
						lockInTrack();

					}

				} else if ( raceCtx ) {

					const kbInput = controls.update();
					const arInput = arManager.getDriveInput();
					const input = {
						x: Math.abs( arInput.x ) > Math.abs( kbInput.x ) ? arInput.x : kbInput.x,
						z: Math.abs( arInput.z ) > Math.abs( kbInput.z ) ? arInput.z : kbInput.z,
						touchActive: kbInput.touchActive,
						handbrake: kbInput.handbrake || arManager.getHandbrakeHold(),
					};
					// simDt (not dt) drives physics/AI/particles/drift-marks
					// — see the TIME_SCALE comment above for why: a real
					// car at real speed, shrunk to fit a table but viewed
					// from the player's real (unshrunk) eye distance,
					// reads as slow motion no matter what the physics says
					// — this is what actually fixes that. Input reading,
					// UI, and light-toggle edge detection above stay on
					// real `dt` since those should still feel immediate.
					const simDt = dt * TIME_SCALE;
					updateVehicleAndFx( simDt, input, raceCtx.ctx );
					updateVehicleLights( raceCtx.vehicleLights, dt, raceCtx.arScale, raceCtx.vehicle.linearSpeed < -0.01, FIXED_SCALE );

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( raceCtx.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( raceCtx.vehicleLights );
					setHighBeam( raceCtx.vehicleLights, arManager.getHighBeamHold(), raceCtx.arScale );
					raceCtx.audio.setHorn( arManager.getHornHold() );

					const radioBtn = arManager.getRadioButtons();
					if ( radioBtn.next ) { stopBgMusic(); raceCtx.radio.next(); }
					if ( radioBtn.toggle ) { stopBgMusic(); raceCtx.radio.togglePlayPause(); }

					// AI opponents: same real pure-pursuit driving as
					// NORMAL mode's own race AI, plus the same lights/
					// flag/smoke/drift-marks the player gets. Smoke reuses
					// the player's own SmokeTrails instance (one shared
					// particle pool/draw call for everyone, cheaper than a
					// separate instance per car) — drift marks stay
					// per-car since each needs its own continuous trail.
					// Driven by the same simDt as the player so the AI
					// keeps pace instead of visually lagging behind a
					// player who now moves 2.5× faster in sim-time.
					totalTime += simDt;
					updateRaceAIDrivers( raceCtx.aiDrivers, trackPath, simDt, true, totalTime, raceCtx.vehicle );
					raceCtx.aiDrivers.forEach( ( d, i ) => {

						const extra = raceCtx.aiExtras[ i ];
						raceCtx.aiParticles.update( simDt, d.vehicle );
						extra.driftMarks.update( simDt, d.vehicle );
						updateVehicleLights( extra.lights, dt, raceCtx.arScale, d.vehicle.linearSpeed < -0.01, FIXED_SCALE );
						if ( extra.flag ) extra.flag.updateFlutter( simDt, Math.abs( d.vehicle.linearSpeed / MAX_SPEED ) );

					} );

				}

			} catch ( e ) {

				console.error( '[main] floating-track frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

// ─── AR floating arena (Stage 4) ────────────────────────────
// An open rectangle for drifting — flat asphalt with the track's own
// red/white barrier around all 4 edges (buildBarrierSegment, same as the
// real track, world=null for visual-only/no physics), a curb-striped
// edge line, and corner dressing (floodlight poles, tire stacks, parked
// decoration cars) — but no walls/track loop of its own. Grabbable/
// movable/scalable (PlaceableObject) and a simple kinematic car, same
// mechanic as the floating track. halfX/halfZ are independent (was a
// single `half`, square-only) per feedback that the pad should be
// rectangular and bigger rather than a square.
function buildDriftPad( halfX, halfZ, models, scale = 1 ) {

	const pad = new THREE.Group();

	// Solid color sampled directly from the track's own shared palette
	// texture (models/Textures/colormap.png) — reverted from a custom
	// GLB asset (ground-tile.glb) back to a plain runtime-built plane,
	// since the GLB version was rendering as washed-out white instead
	// of the intended dark asphalt gray for reasons not fully
	// root-caused.
	const groundMesh = new THREE.Mesh(
		new THREE.PlaneGeometry( halfX * 2, halfZ * 2 ),
		new THREE.MeshStandardMaterial( { color: 0x3a3a40, roughness: 1, metalness: 0 } )
	);
	groundMesh.rotation.x = - Math.PI / 2;
	pad.add( groundMesh );

	// Same white-edge-line + red-rumble-strip curb as the web free-roam
	// arena, traced just inside the barrier loop below — keeps the pad's
	// edge styling consistent with the actual race track across web/AR.
	const edgeTexture = createTrackEdgeTexture( halfX * 2, halfZ * 2, halfX, halfZ );
	const edgeOverlay = new THREE.Mesh(
		new THREE.PlaneGeometry( halfX * 2, halfZ * 2 ),
		new THREE.MeshStandardMaterial( {
			map: edgeTexture, transparent: true, roughness: 0.9,
			metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
		} )
	);
	edgeOverlay.rotation.x = - Math.PI / 2;
	edgeOverlay.position.y = 0.001;
	pad.add( edgeOverlay );

	// heightScale left at its real default (1, same as the web free-roam
	// arena's own barrier at line ~2241) — a previous 4x here made the
	// barrier read as unrealistically tall next to the car (nearly 2.4m,
	// taller than the car itself) once CAR_VISUAL_BOOST was removed and
	// everything else went back to true 1:1 proportions. The barrier is a
	// low real-world jersey barrier (0.6m), meant to sit well below car
	// height, exactly like it does in web mode.
	buildBarrierLoop( pad, null, halfX, halfZ );

	// Floodlight poles + scattered tire stacks/parked decoration cars at
	// the 4 corners, same dressing as the web free-roam arena — added to
	// `pad` itself (not `scene`) so it grabs/moves/scales together with
	// the rest of the arena instead of staying behind at world scale.
	// `scale` (the caller's FIXED_SCALE) is forwarded to each pole so its
	// real SpotLight's distance/intensity scale down with the arena
	// instead of blowing out the tiny scaled-down scene.
	const poleInsetX = halfX * 0.82;
	const poleInsetZ = halfZ * 0.82;
	for ( const cx of [ -1, 1 ] ) {

		for ( const cz of [ -1, 1 ] ) {

			buildFloodlightPoleVisual( pad, cx * poleInsetX, cz * poleInsetZ, { x: 0, z: 0 }, 9, scale );

		}

	}

	// No `world` yet at this point (buildDriftPad runs during AR
	// placement/preview, before the arena is locked in and its physics
	// world is created) — stash the returned placement list on the group
	// itself so lockInAndStart() can build matching colliders later from
	// these exact captured positions/rotations instead of re-randomizing.
	pad.userData.decor = scatterCornerDecor( pad, models, halfX, halfZ, [ 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red' ] );

	return pad;

}

// Kinematic version of the web free-roam AI (random wander target,
// always full throttle, no easing off for turns — same idea as
// updateFreeRoamAI in the web build) for the floating arena. halfX/halfZ
// independent for the rectangular pad.
function createKinematicArenaAI( npcConfigs, models, parentGroup, halfX, halfZ ) {

	const spawnMarginX = halfX * 0.5;
	const spawnMarginZ = halfZ * 0.5;

	return npcConfigs.map( ( cfg, i ) => {

		const angle = ( i / npcConfigs.length ) * Math.PI * 2;
		const distFrac = 0.4 + Math.random() * 0.5;
		const x = Math.cos( angle ) * spawnMarginX * distFrac;
		const z = Math.sin( angle ) * spawnMarginZ * distFrac;
		const heading = Math.random() * Math.PI * 2;

		const model = ( models[ cfg.key ] || models[ 'vehicle-truck-yellow' ] ).clone();
		model.traverse( ( c ) => { if ( c.isMesh ) { c.castShadow = false; c.receiveShadow = false; } } );
		model.position.set( x, 0.5, z );
		model.rotation.y = heading;
		parentGroup.add( model );

		return { model, x, z, heading, speed: 0, target: { x, z }, retargetTimer: 0 };

	} );

}

function updateKinematicArenaAI( drivers, dt, racing, halfX, halfZ ) {

	const wanderRadiusX = halfX * 0.6;
	const wanderRadiusZ = halfZ * 0.6;
	const MAX_SPEED = 8, ACCEL = 10, TURN_RATE = 3.5;

	for ( const d of drivers ) {

		if ( ! racing ) continue;

		d.retargetTimer -= dt;
		const distToTarget = Math.hypot( d.target.x - d.x, d.target.z - d.z );

		if ( d.retargetTimer <= 0 || distToTarget < 3 ) {

			const a = Math.random() * Math.PI * 2;
			const r = Math.random();
			d.target = { x: Math.cos( a ) * wanderRadiusX * r, z: Math.sin( a ) * wanderRadiusZ * r };
			d.retargetTimer = 2 + Math.random() * 3;

		}

		const dx = d.target.x - d.x, dz = d.target.z - d.z;
		const dist = Math.hypot( dx, dz );

		if ( dist > 0.001 ) {

			const targetAngle = Math.atan2( dx, dz );
			let angleDiff = targetAngle - d.heading;
			// Wrap to (-PI, PI]. NOTE: `((x+PI)%(2*PI))-PI` alone is
			// broken in JavaScript for x below -PI, because JS `%` keeps
			// the sign of the dividend (unlike e.g. Python's modulo) —
			// see the normalizeAngle() comment in AIController.js for the
			// full writeup and a real-physics repro. The extra
			// `+2*PI)%(2*PI)` forces a non-negative intermediate first.
			angleDiff = ( ( ( angleDiff + Math.PI ) % ( Math.PI * 2 ) + Math.PI * 2 ) % ( Math.PI * 2 ) ) - Math.PI;
			d.heading += THREE.MathUtils.clamp( angleDiff, - TURN_RATE * dt, TURN_RATE * dt );

		}

		d.speed += THREE.MathUtils.clamp( MAX_SPEED - d.speed, - ACCEL * dt, ACCEL * dt );
		d.x += Math.sin( d.heading ) * d.speed * dt;
		d.z += Math.cos( d.heading ) * d.speed * dt;

		const margin = 2;
		d.x = THREE.MathUtils.clamp( d.x, - halfX + margin, halfX - margin );
		d.z = THREE.MathUtils.clamp( d.z, - halfZ + margin, halfZ - margin );

		d.model.position.set( d.x, 0.5, d.z );
		d.model.rotation.y = d.heading;

	}

}

async function startARFloatingArena( { arManager, vehicleKey, customText, flagImage } ) {

	// Hit-test IS used (see the placing phase in frameUpdate below, via
	// arManager.updateExternalPlacement()) — just not ARManager's own
	// generic ring/arrow previewGroup, since the actual arena itself
	// (arenaGroup) is the preview here.
	arManager.previewGroup.visible = false;

	const placeholderCamera = new THREE.PerspectiveCamera();

	// Rectangular now (not square) and bigger overall, per feedback — X is
	// the long side. buildDriftPad/buildBarrierLoop/scatterCornerDecor/
	// the AI helpers below all take independent halfX/halfZ now instead of
	// one square `half`.
	// Bumped up from 16×10 per feedback that the arena felt small —
	// same ~1.3× per side (≈75% more floor area). Every wall/ground
	// collider and visual dressing below is already derived from these
	// two constants, so nothing else needs to change to match.
	const PAD_HALF_X = 21;
	const PAD_HALF_Z = 13;

	// ✏️ EASY RETUNING KNOBS — see the identical comment in
	// startARFloatingTrack for what each one does (including TIME_SCALE,
	// used below via simDt, and why CAR_VISUAL_BOOST was removed in favor
	// of FIXED_SCALE being the one, consistent size knob) and why they're
	// all safe to change freely (purely cosmetic/pacing, no
	// physics-stability impact).
	// Bumped up (0.03 → 0.039, ~30%) — same reasoning and same relative
	// bump as the identical change in startARFloatingTrack.
	// Declared before buildDriftPad() (moved up from below) so it can be
	// forwarded into the pole lights' distance/intensity scaling.
	const FIXED_SCALE = 0.039;
	const arenaGroup = buildDriftPad( PAD_HALF_X, PAD_HALF_Z, models, FIXED_SCALE );

	// buildDriftPad() starts at identity transform (no internal offset
	// baked in, unlike buildTrack()'s trackGroup) — so unlike the
	// floating track, arenaGroup's own scale/position can be set
	// directly here without needing an extra wrapper group.
	// Reset to the game's base speed — see the identical note in
	// startARFloatingTrack.
	const TIME_SCALE = 1;
	// How long (seconds) a tire/drift mark stays on the ground before
	// fading — see the identical note in startARFloatingTrack.
	const DRIFT_MARK_LIFETIME = 4;
	// Extra headlight dimming, on top of FIXED_SCALE's own size-based
	// scaling — see the identical note in startARFloatingTrack.
	const AR_LIGHT_DAMPING = 0.35;
	arenaGroup.scale.setScalar( FIXED_SCALE );
	// Position/rotation are no longer a fixed guess — see the placing-
	// phase in frameUpdate below, which drives arenaGroup from the same
	// real-surface hit-test the room-drive AR mode uses (ARManager's
	// updateExternalPlacement()), so the arena lands on an actual
	// detected table/floor instead of floating at a hardcoded distance.
	// Hidden until the first surface hit lands.
	arenaGroup.visible = false;
	scene.add( arenaGroup );

	const light = new THREE.DirectionalLight( 0xffffff, 3 );
	light.position.set( 0.6, 1, 0.6 );
	light.castShadow = true;
	const shadowExtent = Math.max( PAD_HALF_X, PAD_HALF_Z ) * 2 * FIXED_SCALE;
	light.shadow.camera.left = - shadowExtent;
	light.shadow.camera.right = shadowExtent;
	light.shadow.camera.top = shadowExtent;
	light.shadow.camera.bottom = - shadowExtent;
	light.shadow.camera.near = 0.1;
	light.shadow.camera.far = shadowExtent * 4;
	light.shadow.mapSize.setScalar( 1024 );
	light.shadow.camera.updateProjectionMatrix();
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.6 ) );

	// Same fix as startARFloatingTrack: dirLight (module-level, top of
	// file) is created once at page load and stays castShadow=true
	// forever unless something turns it off — nothing did for this mode,
	// so it was rendering a second full shadow-casting pass every frame
	// on top of this mode's own `light` above (and double-lighting the
	// scene from two directional sources at once). That extra shadow
	// pass is real, avoidable GPU cost — the kind that pushes frame time
	// past a Quest's budget and shows up as reprojection judder when
	// turning your head after locking the arena in. Page reload on exit
	// restores it for the next mode.
	dirLight.visible = false;

	// ── Placement-phase preview: lightweight kinematic car + AI ──
	const previewContainer = new THREE.Group();
	const previewModel = ( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] ).clone();
	previewModel.traverse( ( c ) => { if ( c.isMesh ) { c.castShadow = false; c.receiveShadow = false; } } );
	previewContainer.add( previewModel );
	previewContainer.position.set( 0, 0.5, 0 );
	arenaGroup.add( previewContainer );

	const previewAI = createKinematicArenaAI(
		NPC_TRUCKS.map( ( [ key ] ) => ( { key } ) ),
		models, arenaGroup, PAD_HALF_X, PAD_HALF_Z
	);

	let phase = 'placing'; // 'placing' -> 'racing'
	let raceCtx = null;

	function lockInAndStart() {

		try {

		arenaGroup.remove( previewContainer );
		previewAI.forEach( ( d ) => arenaGroup.remove( d.model ) );

		// Physics now runs at REAL scale, exactly like NORMAL mode's own
		// free-roam arena (real 9.81 gravity, real 0.5m car radius, real
		// PAD_HALF_X/PAD_HALF_Z-sized floor) — see the floating track's
		// identical fix/comment for why: shrinking physics itself down to
		// tabletop size
		// fights crashcat's own distance tolerances and Vehicle.js's
		// real-world-tuned driving-feel constants, which is what caused
		// the reported "car behaves oddly" symptom. `arenaGroup` itself
		// already carries the only thing actually needed for the AR
		// "tabletop" look — a pure VISUAL scale+placement transform (frozen
		// from this point on since frameUpdate stops calling
		// arManager.updateExternalPlacement() once phase leaves 'placing')
		// — so simulating underneath
		// it at full scale and parenting the car directly under
		// `arenaGroup` (see vehicleGroup below) lets three.js handle the
		// shrink automatically.
		const world = createPhysicsWorld();

		const groundHalfY = 0.01;
		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ PAD_HALF_X, groundHalfY, PAD_HALF_Z ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [ 0, - 0.125, 0 ],
			friction: 5.0,
			restitution: 0.0,
		} );

		// Four boundary walls matching the visual barrier loop's
		// rectangular footprint — same real-scale wall dimensions as
		// NORMAL mode's own free-roam arena walls (see startNormalMode's
		// freeRoam branch). North/south walls run along X at z=±PAD_HALF_Z;
		// east/west walls run along Z at x=±PAD_HALF_X.
		const wallHalfHeight = 1.0;
		const wallThickness = 0.2;
		const wallLocalY = - 0.125 + wallHalfHeight;
		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ PAD_HALF_X, wallHalfHeight, wallThickness ] } ),
				motionType: MotionType.STATIC, objectLayer: world._OL_STATIC,
				position: [ 0, wallLocalY, sign * PAD_HALF_Z ], friction: 0.2, restitution: 0.3,
			} );

			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ wallThickness, wallHalfHeight, PAD_HALF_Z ] } ),
				motionType: MotionType.STATIC, objectLayer: world._OL_STATIC,
				position: [ sign * PAD_HALF_X, wallLocalY, 0 ], friction: 0.2, restitution: 0.3,
			} );

		}

		// Floodlight pole colliders — same real-scale local coordinate
		// space as the ground/wall colliders above (this physics `world`
		// runs at real scale, with arenaGroup's own scale+placement
		// transform doing the visual shrink/positioning — see the long
		// comment above this function). Same 0.82 inset formula as
		// buildDriftPad's own pole placement, since arenaGroup === the
		// `pad` group buildDriftPad built, so their local spaces match
		// exactly.
		const poleInsetX = PAD_HALF_X * 0.82;
		const poleInsetZ = PAD_HALF_Z * 0.82;
		const poleHeight = 9;
		for ( const cx of [ -1, 1 ] ) {

			for ( const cz of [ -1, 1 ] ) {

				rigidBody.create( world, {
					shape: cylinder.create( { halfHeight: poleHeight / 2, radius: 0.16 } ),
					motionType: MotionType.STATIC,
					objectLayer: world._OL_STATIC,
					position: [ cx * poleInsetX, poleHeight / 2, cz * poleInsetZ ],
					friction: 0.4,
					restitution: 0.15,
				} );

			}

		}

		// Tire stack / decoration car colliders, from the exact positions
		// scatterCornerDecor() actually placed them at (stashed on
		// arenaGroup.userData.decor by buildDriftPad) — not re-randomized,
		// so they line up with the visuals.
		if ( arenaGroup.userData.decor ) addDecorColliders( world, arenaGroup.userData.decor );

		// Real 0.5m car radius, spawned at the arena's own local center —
		// same defaults NORMAL mode's own free-roam arena uses.
		const sphereBody = createSphereBody( world, [ 0, 0.5, 0 ] );

		const vehicle = new Vehicle();
		vehicle.rigidBody = sphereBody;
		vehicle.physicsWorld = world;
		vehicle.spawnPos = [ 0, 0.5, 0 ];
		vehicle.spawnAngle = 0;
		vehicle.spherePos.set( 0, 0.5, 0 );
		vehicle.prevModelPos.set( 0, 0, 0 );
		vehicle.container.rotation.y = 0;

		const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
		// Parented under arenaGroup (not scene) — same idea as the
		// floating track's identical change: vehicle.container.position is
		// now real-scale "arena-local" coordinates, and arenaGroup's own
		// frozen scale+placement transform shrinks/places the car in sync
		// with the arena automatically, every frame — no manual coordinate
		// transform needed anywhere in this function.
		arenaGroup.add( vehicleGroup );
		addCustomTextDecals( vehicleGroup, customText );
		const vehicleLights = addVehicleLights( vehicleGroup );
		const vehicleFlag = addVehicleFlag( vehicleGroup, flagImage );

		const audio = new GameAudio();
		audio.init( renderer.xr.getCamera(), vehicleGroup );
		audio.forceUnlock();
		const radio = new Radio( audio.listener, vehicleGroup );

		// Smoke IS scaled for AR — see the identical note in
		// startARFloatingTrack (defaulting to scale=1 caused the reported
		// freeze/hang: real-meter-sized puffs, at default emission rate,
		// shared across the player AND all 3 AI every frame).
		const particles = new SmokeTrails( scene, FIXED_SCALE * 0.7, 0.15 );
		// Same AI-gets-its-own-lighter-pool split as startARFloatingTrack.
		const aiParticles = new SmokeTrails( scene, FIXED_SCALE * 0.7, 0.06 );
		// Drift marks fade out after DRIFT_MARK_LIFETIME seconds — see the
		// identical note in startARFloatingTrack.
		const driftMarks = new DriftMarks( scene, 'ar-floating-arena', FIXED_SCALE, DRIFT_MARK_LIFETIME );

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

		const ctx = { world, vehicle, particles, driftMarks, audio, lapTimer: null, contactListener, vehicleFlag };

		// AI opponents — same wandering "تفحيط" free-roam AI as NORMAL
		// mode's own free-roam arena (createFreeRoamAI, reused unchanged),
		// parented under arenaGroup (passed in place of `scene`) so they
		// shrink/place in sync automatically. No visual boost now (see the
		// CAR_VISUAL_BOOST removal note above) — AI cars stay real/
		// unboosted size, same as the player and the arena's own
		// decoration cars, all governed by the one FIXED_SCALE transform.
		const aiDrivers = createFreeRoamAI(
			NPC_TRUCKS.map( ( [ key ] ) => ( { key } ) ),
			models, arenaGroup, world, PAD_HALF_X, PAD_HALF_Z
		);
		// AI flags always fly this fixed Saudi Arabia flag — never the
		// player's own flagImage — and don't change if the player changes
		// theirs. Flutter is driven every frame below (AI flags were
		// previously created but never animated — only the player's own
		// updateVehicleAndFx() call did that).
		const aiFlagUrl = createSaudiFlagDataUrl();
		const aiExtras = aiDrivers.map( ( d, i ) => {

			const group = d.vehicle.container;
			const lights = addVehicleLights( group );
			lights.hazardsOn = true; // AI always shows hazard/emergency blinkers
			const flag = addVehicleFlag( group, aiFlagUrl );
			const marks = new DriftMarks( scene, 'ar-floating-arena-ai-' + i, FIXED_SCALE, DRIFT_MARK_LIFETIME );
			return { lights, driftMarks: marks, flag };

		} );

		raceCtx = { world, vehicle, vehicleGroup, vehicleLights, audio, radio, ctx, aiDrivers, aiExtras, aiParticles, arScale: FIXED_SCALE * AR_LIGHT_DAMPING };
		phase = 'racing';

		} catch ( e ) {

			console.error( '[main] floating-arena lock-in failed:', e );
			showErrorOverlay(
				( e && e.message ) ? e.message : String( e ),
				e && e.stack ? e.stack : '',
				() => window.location.reload(),
				'تعذّر تثبيت الحلبة — السيارة لم تُنشأ'
			);

		}

	}

	const controls = new Controls();

	return {

		frameUpdate( dt, timestamp, frame ) {

			try {

				if ( phase === 'placing' ) {

					// Same hit-test surface search + thumbstick nudge + trigger
					// confirm as the room-drive AR mode's own placement screen
					// (ARManager.updateExternalPlacement — see its comment, and
					// the identical setup in startARFloatingTrack) — the arena
					// stays hidden and glued to the camera's search until a real
					// surface (table, floor, …) is found, then follows that
					// surface (with thumbstick fine-adjustment) until the
					// trigger is pulled.
					const { hasHit, confirmEdge } = arManager.updateExternalPlacement( frame, dt );

					arenaGroup.visible = hasHit;

					if ( hasHit ) {

						arenaGroup.position.copy( arManager.arPosition );
						arenaGroup.quaternion.copy( arManager.arQuaternion );

					}

					updateKinematicArenaAI( previewAI, dt, false, PAD_HALF_X, PAD_HALF_Z );

					if ( confirmEdge ) {

						lockInAndStart();

					}

				} else if ( phase === 'racing' && raceCtx ) {

					const kbInput = controls.update();
					const arInput = arManager.getDriveInput();
					const input = {
						x: Math.abs( arInput.x ) > Math.abs( kbInput.x ) ? arInput.x : kbInput.x,
						z: Math.abs( arInput.z ) > Math.abs( kbInput.z ) ? arInput.z : kbInput.z,
						touchActive: kbInput.touchActive,
						handbrake: kbInput.handbrake || arManager.getHandbrakeHold(),
					};
					// simDt: physics/AI/particle time runs faster than real dt
					// (see TIME_SCALE note above) to counter the "miniature
					// effect" — a real-speed object viewed at a real, un-
					// shrunk distance always reads as slow motion no matter
					// its true speed, so we speed up sim time instead of
					// touching any physical constant. Input reading, button
					// edge-detection, and light-blink pacing all stay on the
					// real dt so controls and blink rate feel normal.
					const simDt = dt * TIME_SCALE;
					updateVehicleAndFx( simDt, input, raceCtx.ctx );
					updateVehicleLights( raceCtx.vehicleLights, dt, raceCtx.arScale, raceCtx.vehicle.linearSpeed < -0.01, FIXED_SCALE );

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( raceCtx.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( raceCtx.vehicleLights );
					setHighBeam( raceCtx.vehicleLights, arManager.getHighBeamHold(), raceCtx.arScale );
					raceCtx.audio.setHorn( arManager.getHornHold() );

					const radioBtn = arManager.getRadioButtons();
					if ( radioBtn.next ) { stopBgMusic(); raceCtx.radio.next(); }
					if ( radioBtn.toggle ) { stopBgMusic(); raceCtx.radio.togglePlayPause(); }

					// AI opponents: same wandering/drifting free-roam AI as
					// NORMAL mode, plus the same lights/flag/smoke/drift-
					// marks the player gets. Smoke reuses the player's own
					// shared SmokeTrails instance (see the identical note
					// in startARFloatingTrack).
					updateFreeRoamAIDrivers( raceCtx.aiDrivers, simDt, PAD_HALF_X, PAD_HALF_Z );
					raceCtx.aiDrivers.forEach( ( d, i ) => {

						const extra = raceCtx.aiExtras[ i ];
						raceCtx.aiParticles.update( simDt, d.vehicle );
						extra.driftMarks.update( simDt, d.vehicle );
						updateVehicleLights( extra.lights, dt, raceCtx.arScale, d.vehicle.linearSpeed < -0.01, FIXED_SCALE );
						if ( extra.flag ) extra.flag.updateFlutter( simDt, Math.abs( d.vehicle.linearSpeed / MAX_SPEED ) );

					} );

				}

			} catch ( e ) {

				console.error( '[main] floating-arena frameUpdate() error:', e );

			}

			renderer.render( scene, placeholderCamera );

		}

	};

}

async function startARMode( { arManager, mapParam, customText, vehicleKey, flagImage } ) {

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
		const vehicleGroup = vehicle.init( models[ vehicleKey ] || models[ 'vehicle-truck-yellow' ] );
		scene.add( vehicleGroup );
		addCustomTextDecals( vehicleGroup, customText );
		const vehicleLights = addVehicleLights( vehicleGroup );
		const vehicleFlag = addVehicleFlag( vehicleGroup, flagImage );

		dirLight.target = vehicleGroup;

		// vehicleGroup's own origin isn't necessarily at wheel/ground level,
		// so scaling it directly made the car sink into or float above the
		// real floor as it resized. Instead scale only the inner model
		// child, and keep its lowest point pinned at the container's origin
		// (ground level) regardless of scale.
		const vehicleModel = vehicleGroup.children[ 0 ];
		const vehicleModelMinY = new THREE.Box3().setFromObject( vehicleModel ).min.y;

		// Smoke is authored at real-meter scale (BASE_SIZE=1 in Particles.js)
		// for NORMAL mode's much larger track. In AR the car is toy-sized,
		// so shrink smoke drastically or it renders as room-filling clouds
		// — a likely cause of the GPU overdraw/lag reported during drifting.
		const particles = new SmokeTrails( scene, 0.12 );
		// Fades after 9s instead of the default Infinity+localStorage
		// persistence — room-drive draws directly on the player's real
		// floor, so marks sticking around forever (and being saved/
		// restored across sessions) made less sense here than on a
		// purpose-built track.
		const driftMarks = new DriftMarks( scene, mapParam || 'ar-freeroam', 1, 9 );

		const audio = new GameAudio();
		audio.init( renderer.xr.getCamera(), vehicleGroup ); // XR camera rig instead of the NORMAL-mode chase Camera
		// AR mode has no DOM click/touchstart/keydown once inside the XR
		// session (input is XR controller triggers only), so Audio.js's
		// normal gesture-based unlock() would never fire and every sound
		// would stay silent forever. We already know a real user gesture
		// happened (the "Start AR" button press that got us into this
		// session), so it's safe to unlock immediately here instead.
		audio.forceUnlock();

		const radio = new Radio( audio.listener, vehicleGroup );

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
		gameState = {
			vehicle, vehicleGroup, vehicleModel, vehicleModelMinY, vehicleScale: 1,
			particles, driftMarks, audio, radio, vehicleLights, vehicleFlag, contactListener
		};

	};

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
						handbrake: kbInput.handbrake || arManager.getHandbrakeHold(),
					};

					updateVehicleAndFx( dt, input, { world, ...gameState } );
					updateVehicleLights( gameState.vehicleLights, dt, gameState.vehicleScale, gameState.vehicle.linearSpeed < -0.01 );

					const scaleInput = arManager.getScaleAdjustInput();
					if ( scaleInput !== 0 ) {

						gameState.vehicleScale = THREE.MathUtils.clamp(
							gameState.vehicleScale * ( 1 - scaleInput * 0.8 * dt ),
							0.03, 3.0
						);

						const s = gameState.vehicleScale;
						gameState.vehicleModel.scale.setScalar( s );
						// Keep the model's lowest point (wheels) pinned at
						// y=0 in container space — i.e. at ground level —
						// instead of scaling around the model's own origin,
						// which caused it to sink into or float above the
						// real floor as it resized.
						gameState.vehicleModel.position.y = gameState.vehicleModelMinY * ( 1 - s );

					}

					const radioBtn = arManager.getRadioButtons();
					if ( radioBtn.next ) { stopBgMusic(); gameState.radio.next(); }
					if ( radioBtn.toggle ) { stopBgMusic(); gameState.radio.togglePlayPause(); }

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( gameState.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( gameState.vehicleLights );
					setHighBeam( gameState.vehicleLights, arManager.getHighBeamHold(), gameState.vehicleScale );
					gameState.audio.setHorn( arManager.getHornHold() );

					if ( gameState.vehicleLights ) {

						arManager.setFloorGridVisible( gameState.vehicleLights.headlights[ 0 ].light.visible );

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
let crashed = false;

function animate( timestamp, frame ) {

	if ( crashed ) return;

	timer.update( timestamp );
	const dt = Math.min( timer.getDelta(), 1 / 30 );

	try {

		if ( activeMode ) activeMode.frameUpdate( dt, timestamp, frame );

	} catch ( e ) {

		crashed = true;
		console.error( '[animate] crashed:', e );
		showGenericErrorOverlay( e );

	}

}

renderer.setAnimationLoop( animate );

function showGenericErrorOverlay( error ) {

	const box = document.createElement( 'div' );
	box.dir = 'rtl';
	box.style.cssText = `
		position: fixed; inset: 0; z-index: 70; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center;
		background: rgba(20,22,26,0.95); font-family: 'Segoe UI', Tahoma, Arial, sans-serif; overflow-y: auto;
	`;

	const title = document.createElement( 'div' );
	title.textContent = 'صار خطأ وتوقفت اللعبة';
	title.style.cssText = 'color:#fff; font-size:20px; font-weight:700;';

	const msg = document.createElement( 'div' );
	msg.textContent = String( error && error.message ? error.message : error );
	msg.style.cssText = 'color:#ffb4b4; font-size:14px; max-width:90%;';

	const stack = document.createElement( 'pre' );
	stack.textContent = error && error.stack ? error.stack : '';
	stack.style.cssText = `
		color:#9a94b0; font-size:11px; text-align:left; direction:ltr; max-width:90%; max-height:40vh;
		overflow:auto; background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; white-space:pre-wrap;
	`;

	box.appendChild( title );
	box.appendChild( msg );
	box.appendChild( stack );
	document.body.appendChild( box );

}

function showErrorOverlay( message, stack, onRetry, title = 'تعذّر تشغيل وضع الواقع المعزز' ) {

	const box = document.createElement( 'div' );
	box.dir = 'rtl';
	box.style.cssText = `
		position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 16px; padding: 24px; text-align: center;
		background: rgba(20,22,26,0.92); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
	`;

	const titleEl = document.createElement( 'div' );
	titleEl.textContent = title;
	titleEl.style.cssText = 'color:#fff; font-size:18px; font-weight:600;';

	const detail = document.createElement( 'div' );
	detail.textContent = message;
	detail.dir = 'ltr'; // raw browser/JS error text — keep readable, not mirrored
	detail.style.cssText = 'color:#ddd; font-size:14px; max-width:640px; white-space:pre-wrap;';

	const stackBox = document.createElement( 'div' );
	stackBox.textContent = stack ? stack.split( '\n' ).slice( 0, 6 ).join( '\n' ) : '';
	stackBox.dir = 'ltr';
	stackBox.style.cssText = 'color:#999; font-size:11px; max-width:640px; white-space:pre-wrap; text-align:left; font-family:monospace;';

	const retryBtn = document.createElement( 'button' );
	retryBtn.textContent = 'العودة للقائمة';
	retryBtn.style.cssText = `
		padding: 12px 28px; font-size: 15px; border-radius: 999px; border: none;
		cursor: pointer; background: #15A249; color: #fff;
	`;
	retryBtn.addEventListener( 'click', () => {

		box.remove();
		onRetry();

	} );

	box.appendChild( titleEl );
	box.appendChild( detail );
	box.appendChild( stackBox );
	box.appendChild( retryBtn );
	document.body.appendChild( box );

	console.error( title + ':', message, stack );

}

// Shown by init() right after a reload triggered by the in-AR "رجوع
// لأوضاع AR" button (see openExitConfirm's hwReturnToArMenu stash) —
// a minimal single-tap re-entry into AR instead of the full main menu.
// WebXR requires a fresh user gesture to (re-)request a session, so this
// can't be skipped even though the vehicle/text/flag choice already
// carried over from before the reload. Resolves { sessionPromise } once
// tapped (same shape createModeMenu()'s own AR button resolves with);
// rejects if the person instead taps through to the full main menu.
function showArResumeOverlay() {

	return new Promise( ( resolve, reject ) => {

		const box = document.createElement( 'div' );
		box.dir = 'rtl';
		box.style.cssText = `
			position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
			align-items: center; justify-content: center; gap: 18px; padding: 24px; text-align: center;
			background: rgba(20,22,26,0.95); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
		`;

		const title = document.createElement( 'div' );
		title.textContent = 'الرجوع للواقع المعزز';
		title.style.cssText = 'color:#fff; font-size:19px; font-weight:700;';

		const msg = document.createElement( 'div' );
		msg.textContent = 'اضغط للمتابعة واختيار المضمار أو الحلبة أو وضع الغرفة الحرة.';
		msg.style.cssText = 'color:#ccc; font-size:14px; max-width:420px;';

		const enterBtn = document.createElement( 'button' );
		enterBtn.textContent = 'الدخول للواقع المعزز';
		enterBtn.style.cssText = `
			padding: 14px 32px; font-size: 16px; border-radius: 999px; border: none;
			cursor: pointer; background: #15A249; color: #fff; font-weight:600;
		`;
		enterBtn.addEventListener( 'click', () => {

			// requestSession() started synchronously inside this click
			// handler, same reasoning as createModeMenu()'s own AR button —
			// some browsers only honor user-activation for a call made
			// directly in the event handler, not after any await hops.
			const sessionPromise = navigator.xr.requestSession( 'immersive-ar', {
				requiredFeatures: [ 'local-floor', 'hit-test' ],
				optionalFeatures: [ 'plane-detection', 'mesh-detection' ],
			} );
			startBgMusic();
			box.remove();
			resolve( { sessionPromise } );

		} );

		const homeBtn = document.createElement( 'button' );
		homeBtn.textContent = 'الرجوع للقائمة الرئيسية';
		homeBtn.style.cssText = `
			padding: 10px 24px; font-size: 13px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.3);
			cursor: pointer; background: transparent; color: #ccc;
		`;
		homeBtn.addEventListener( 'click', () => {

			box.remove();
			reject( new Error( 'user chose the main menu instead' ) );

		} );

		box.appendChild( title );
		box.appendChild( msg );
		box.appendChild( enterBtn );
		box.appendChild( homeBtn );
		document.body.appendChild( box );

	} );

}

async function init() {

	registerAll();
	await loadModels();

	const mapParam = new URLSearchParams( window.location.search ).get( 'map' );
	let customCells = null;
	// Was only computed inside the `if (mapParam)` block below, leaving
	// it null for the default track (no ?map=) — which silently skipped
	// the grid-start/AI-opponent system, since that code all guards on
	// `spawn` being present. computeSpawnPosition() now defaults to the
	// built-in TRACK_CELLS on its own, so this works for both cases.
	let spawn = computeSpawnPosition( null );

	if ( mapParam ) {

		try {

			customCells = decodeCells( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

		}

	}

	// "إعادة السباق" (restart race) reloads the page for a guaranteed-clean
	// scene/physics-world reset — rebuilding everything in place without a
	// reload risks leaking the old track/car meshes and physics colliders
	// into the shared scene. What it should NOT do is send the player back
	// through the mode-selection menu first. onRestart below stashes the
	// race's exact settings here before reloading; if present, skip
	// straight to startNormalMode() with them instead of showing the menu.
	let restartData = null;
	try {
		const raw = sessionStorage.getItem( 'hwRestartRace' );
		if ( raw ) restartData = JSON.parse( raw );
	} catch ( e ) {
		restartData = null;
	}
	try {
		sessionStorage.removeItem( 'hwRestartRace' );
	} catch ( e ) { /* ignore */ }

	if ( restartData ) {

		try {

			activeMode = startNormalMode( { customCells, spawn, mapParam, ...restartData } );
			return;

		} catch ( e ) {

			activeMode = null; // fall through to the normal menu flow below

		}

	}

	// "رجوع لأوضاع AR" (the in-AR home button/exit-confirm) reloads the
	// page the same "start clean" way "إعادة السباق" above does, but
	// should land back on the AR track/arena/room picker specifically —
	// not the game's full main menu. openExitConfirm() (inside
	// startARWithFloatingMenu) stashes the vehicle/text/flag choice here
	// before reloading; if present, skip the main menu and show one small
	// "re-enter AR" button instead (a fresh user gesture is required to
	// re-request a WebXR session — browsers won't allow that
	// automatically right after a reload, so this can't jump straight
	// back in without SOME tap).
	let returnToArMenu = null;
	try {
		const rawAr = sessionStorage.getItem( 'hwReturnToArMenu' );
		if ( rawAr ) returnToArMenu = JSON.parse( rawAr );
	} catch ( e ) {
		returnToArMenu = null;
	}
	try {
		sessionStorage.removeItem( 'hwReturnToArMenu' );
	} catch ( e ) { /* ignore */ }

	const arAvailable = await ARManager.isSupported();

	if ( returnToArMenu && arAvailable ) {

		try {

			const { sessionPromise } = await showArResumeOverlay();
			activeMode = await startARWithFloatingMenu( {
				mapParam,
				customText: returnToArMenu.customText,
				vehicleKey: returnToArMenu.vehicleKey,
				flagImage: returnToArMenu.flagImage,
				sessionPromise,
			} );
			return;

		} catch ( e ) {

			activeMode = null; // fall through to the normal menu flow below

		}

	}

	// eslint-disable-next-line no-constant-condition
	while ( true ) {

		const { choice, customText, freeRoam, vehicleKey, flagImage, sessionPromise } = await createModeMenu( { arAvailable } );

		if ( choice === 'ar' ) {

			try {

				activeMode = await startARWithFloatingMenu( { mapParam, customText, vehicleKey, flagImage, sessionPromise } );
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

			try {

				activeMode = startNormalMode( { customCells, spawn, mapParam, customText, freeRoam, vehicleKey, flagImage } );
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

		}

	}

}

init();
