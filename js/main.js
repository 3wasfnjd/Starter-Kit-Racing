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
import { createFlag } from './Flag.js';
import { LapTimer } from './LapTimer.js';
import { ColorMapGLTFLoader } from './Loader.js';
import { ARManager } from './ARManager.js';
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
					<label class="hw-checkbox-row">
						<input type="checkbox" class="hw-freeroam-checkbox" />
						الوضع العادي: تحكم حر بدون مضمار
					</label>
					<div class="hw-mode-row">
						<button class="hw-mode-card primary hw-normal-btn">
							<svg viewBox="0 0 24 24" fill="none" stroke="#5B8CFF" stroke-width="1.6">
								<circle cx="12" cy="12" r="9"/>
								<circle cx="12" cy="12" r="2.4" fill="#5B8CFF" stroke="none"/>
								<path d="M12 5v4.6M6.2 15.5l3.6-2.2M17.8 15.5l-3.6-2.2"/>
							</svg>
							<div class="hw-mode-label">الوضع العادي</div>
							<div class="hw-mode-sub">مضمار كلاسيكي</div>
						</button>
						<button class="hw-mode-card hw-ar-btn" ${ arAvailable ? '' : 'disabled' }>
							<svg viewBox="0 0 24 24" fill="none" stroke="#cfc9e0" stroke-width="1.6">
								<rect x="2.5" y="8" width="19" height="9" rx="3.5"/>
								<circle cx="8.3" cy="12.5" r="1.9"/>
								<circle cx="15.7" cy="12.5" r="1.9"/>
								<path d="M9.8 12.5h4.4"/>
								<path d="M6 8c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4"/>
							</svg>
							<div class="hw-mode-label">الواقع المعزز</div>
							<div class="hw-mode-sub">${ arAvailable ? 'Meta Quest 3' : 'غير متاح على هذا الجهاز' }</div>
						</button>
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
		const freeRoamCheckbox = menu.querySelector( '.hw-freeroam-checkbox' );
		const normalBtn = menu.querySelector( '.hw-normal-btn' );
		const arBtn = menu.querySelector( '.hw-ar-btn' );

		normalBtn.addEventListener( 'click', () => {

			requestFullscreenSafe();
			menu.remove();
			resolve( { choice: 'normal', customText: textInput.value.trim(), freeRoam: freeRoamCheckbox.checked, vehicleKey: selectedVehicle, flagImage: flagImageDataUrl } );

		} );

		arBtn.addEventListener( 'click', () => {

			if ( arBtn.disabled ) return;
			// No requestFullscreenSafe() here on purpose: it would consume
			// the click's transient user-activation, and requestSession()
			// below needs that same activation. AR sessions take over the
			// whole display anyway, so it's moot.
			//
			// requestSession() itself is also started HERE, synchronously,
			// rather than later inside startARMode() — some browsers only
			// honor user-activation for a call made directly in the event
			// handler, not after several chained await hops. The resulting
			// promise is handed off and awaited downstream.
			const sessionPromise = navigator.xr.requestSession( 'immersive-ar', {
				requiredFeatures: [ 'local-floor', 'hit-test' ],
				optionalFeatures: [ 'plane-detection', 'mesh-detection' ],
			} );

			menu.remove();
			resolve( {
				choice: 'ar', customText: textInput.value.trim(), freeRoam: freeRoamCheckbox.checked,
				vehicleKey: selectedVehicle, flagImage: flagImageDataUrl, sessionPromise,
			} );

		} );

		const featuresLink = menu.querySelector( '.hw-features-link' );
		featuresLink.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			showFeaturesModal();

		} );

		document.body.appendChild( menu );

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
	ctx.fillStyle = '#18181a';
	ctx.fillRect( 0, 0, size, size );

	for ( let i = 0; i < 1400; i ++ ) {

		const x = Math.random() * size, y = Math.random() * size;
		const v = 12 + Math.random() * 22;
		ctx.fillStyle = `rgba(${ v },${ v },${ v + 2 },${ 0.25 + Math.random() * 0.3 })`;
		ctx.fillRect( x, y, 1.4, 1.4 );

	}

	const texture = new THREE.CanvasTexture( canvas );
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
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
	flag.group.position.set( -0.5, 0.08, -1.3 );
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
	const headlights = [];
	for ( const side of [ -1, 1 ] ) {

		const baseDistance = 14;
		const baseIntensity = 3000;
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
		const light = new THREE.PointLight( 0xff3b30, 0.8, baseDistance, 2 );
		const basePosition = new THREE.Vector3( side * 0.4, 0.43, -1.32 );
		light.position.copy( basePosition );
		bodyNode.add( light );
		taillights.push( { light, basePosition, baseDistance } );

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
		const light = new THREE.PointLight( 0xff8c1a, 3, baseDistance, 2 );
		const basePosition = new THREE.Vector3( x, y, z );
		light.position.copy( basePosition );
		light.visible = false;
		bodyNode.add( light );
		hazards.push( { light, basePosition, baseDistance } );

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
function setHighBeam( vehicleLights, on ) {

	if ( ! vehicleLights ) return;
	if ( vehicleLights._highBeamOn === on ) return; // no change, skip

	if ( on ) vehicleLights._headlightsBeforeHighBeam = vehicleLights.headlights[ 0 ].light.visible;
	vehicleLights._highBeamOn = on;

	vehicleLights.headlights.forEach( ( h ) => {

		if ( on ) {

			h.light.visible = true;
			h.light.intensity = h.baseIntensity * 2.5;
			h.light.distance = h.baseDistance * 1.4;

		} else {

			h.light.intensity = h.baseIntensity;
			h.light.distance = h.baseDistance;
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
function updateVehicleLights( vehicleLights, dt, scale, isReversing = false ) {

	if ( ! vehicleLights ) return;

	// Deliberately NOT scaling light .distance with vehicle size — the
	// headlight's job is to illuminate the real room, which stays the
	// same size regardless of how small the car gets. Shrinking the
	// range along with the car meant a small car's light barely reached
	// anything, looking like it "faded off" as it shrank. Range now
	// stays constant no matter the car size (position/visual size still
	// track the car normally, via the transform hierarchy).

	if ( vehicleLights.reverseLights ) {

		vehicleLights.reverseLights.forEach( ( r ) => {

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

// ─── Touch radio controls (phones/tablets — no keyboard, no VR hands) ──
// Controls.js already covers a full-screen invisible steering zone for
// touch, so these buttons need a higher z-index to receive taps first.

function setupRadioTouchUI( radio, vehicleLights ) {

	if ( ! ( 'ontouchstart' in window ) ) return;

	const wrap = document.createElement( 'div' );
	wrap.style.cssText = `
		position: fixed; left: 16px; bottom: 16px; z-index: 30;
		display: flex; flex-direction: column; gap: 10px;
	`;

	function makeTapButton( label ) {

		const btn = document.createElement( 'button' );
		btn.textContent = label;
		btn.style.cssText = `
			width: 56px; height: 56px; border-radius: 50%;
			border: 2px solid rgba(255,255,255,0.85);
			background: rgba(15,17,20,0.75); color: #fff; font-size: 24px;
			display: flex; align-items: center; justify-content: center;
			box-shadow: 0 3px 10px rgba(0,0,0,0.45);
			touch-action: manipulation;
		`;
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
		radio.next();

	} );
	toggleBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
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
	highBeamBtn.addEventListener( 'pointerdown', ( e ) => {

		e.stopPropagation();
		setHighBeam( vehicleLights, true );

	} );
	[ 'pointerup', 'pointerleave', 'pointercancel' ].forEach( ( evt ) => {

		highBeamBtn.addEventListener( evt, ( e ) => {

			e.stopPropagation();
			setHighBeam( vehicleLights, false );

		} );

	} );

	wrap.appendChild( nextBtn );
	wrap.appendChild( toggleBtn );
	wrap.appendChild( headlightBtn );
	wrap.appendChild( hazardBtn );
	wrap.appendChild( highBeamBtn );
	document.body.appendChild( wrap );

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

// ─── NORMAL MODE (unchanged behavior from the original game) ──

function startNormalMode( { customCells, spawn, mapParam, customText, freeRoam, vehicleKey, flagImage } ) {

	const world = createPhysicsWorld();
	let sphereBody, vehicleSpawn, lapTimer = null;

	if ( freeRoam ) {

		// Open sandbox: no track, no walls — just a big flat ground.
		const groundSize = 200;

		const shadowExtent = 40;
		dirLight.shadow.camera.left = - shadowExtent;
		dirLight.shadow.camera.right = shadowExtent;
		dirLight.shadow.camera.top = shadowExtent;
		dirLight.shadow.camera.bottom = - shadowExtent;
		dirLight.shadow.camera.updateProjectionMatrix();

		scene.fog.near = 60;
		scene.fog.far = 140;

		const roadHalf = groundSize / 2;
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

			buildGrandstandWall( scene, 'x', roadHalf * 2, sign * roadHalf, wallThickness, sign );
			buildGrandstandWall( scene, 'z', roadHalf * 2, sign * roadHalf, wallThickness, sign );

		}

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

		vehicleSpawn = spawn;
		sphereBody = createSphereBody( world, spawn ? spawn.position : null );
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
	const driftMarks = new DriftMarks( scene, mapParam );

	const audio = new GameAudio();
	audio.init( cam.camera, vehicleGroup );

	const radio = new Radio( audio.listener, vehicleGroup );
	setupRadioTouchUI( radio, vehicleLights );

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

	return {

		frameUpdate( dt ) {

			const input = controls.update();

			updateVehicleAndFx( dt, input, ctx );
			updateVehicleLights( vehicleLights, dt, 1, vehicle.linearSpeed < -0.01 );

			const rKey = !! controls.keys[ 'KeyR' ];
			const tKey = !! controls.keys[ 'KeyT' ];
			const lKey = !! controls.keys[ 'KeyL' ];
			const hKey = !! controls.keys[ 'KeyH' ];
			const nKey = !! controls.keys[ 'KeyN' ];
			if ( rKey && ! prevKeys.r ) radio.next();
			if ( tKey && ! prevKeys.t ) radio.togglePlayPause();
			if ( lKey && ! prevKeys.l ) toggleHeadlights( vehicleLights );
			if ( hKey && ! prevKeys.h ) toggleHazards( vehicleLights );
			setHighBeam( vehicleLights, nKey );
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

async function startARMode( { mapParam, customText, vehicleKey, flagImage, sessionPromise } ) {

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
		const driftMarks = new DriftMarks( scene, mapParam || 'ar-freeroam' );

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

	const xrSession = await arManager.requestSession( sessionPromise );

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
					if ( radioBtn.next ) gameState.radio.next();
					if ( radioBtn.toggle ) gameState.radio.togglePlayPause();

					if ( arManager.getHeadlightToggle() ) toggleHeadlights( gameState.vehicleLights );
					if ( arManager.getHazardToggle() ) toggleHazards( gameState.vehicleLights );
					setHighBeam( gameState.vehicleLights, arManager.getHighBeamHold() );
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

function animate( timestamp, frame ) {

	timer.update( timestamp );
	const dt = Math.min( timer.getDelta(), 1 / 30 );

	if ( activeMode ) activeMode.frameUpdate( dt, timestamp, frame );

}

renderer.setAnimationLoop( animate );

function showErrorOverlay( message, stack, onRetry ) {

	const box = document.createElement( 'div' );
	box.dir = 'rtl';
	box.style.cssText = `
		position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 16px; padding: 24px; text-align: center;
		background: rgba(20,22,26,0.92); font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
	`;

	const title = document.createElement( 'div' );
	title.textContent = 'تعذّر تشغيل وضع الواقع المعزز';
	title.style.cssText = 'color:#fff; font-size:18px; font-weight:600;';

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

		const { choice, customText, freeRoam, vehicleKey, flagImage, sessionPromise } = await createModeMenu( { arAvailable } );

		if ( choice === 'ar' ) {

			try {

				activeMode = await startARMode( { mapParam, customText, vehicleKey, flagImage, sessionPromise } );
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

			activeMode = startNormalMode( { customCells, spawn, mapParam, customText, freeRoam, vehicleKey, flagImage } );
			break;

		}

	}

}

init();
