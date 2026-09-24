// All fox + logo materials live here so colours can be calibrated in one place.
// Materials are replaced by glTF material name (Blender may append ".001" etc.).
import * as THREE from 'three';

// sRGB hex values (reference/README.md). THREE.Color converts them to linear.
export const PALETTE = {
  eye: '#2E1B14',
  nose: '#3A2119',
  line: '#3A2119',
  mouthInside: '#8E3B35',
  tongue: '#F08C8C',
  logoCube: '#F4E2CE',
  logoStar: '#F58D4E',
  sheen: '#FFF1E4',
  scarfSheen: '#FFD2B8',
};

// Tunables for the procedural surface detail.
export const SURFACE = {
  furGrainScale: 165, // noise cells per unit (fox height = 1): a few px at the default framing
  furGrainStrength: 0.30, // normal tilt from the flocked grain
  furMottle: 0.09, // albedo variation from the same noise (velvet speckle)
  scarfGrainScale: 120, // used only when the scarf has no UVs
  knitRepeat: [2, 2], // knit tiles per UV unit (tune to the scarf's UV scale)
  knitNormalScale: 0.7,
};

const DEFS = {
  Fur: () => new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.55, // broad soft velvet rim instead of a plastic highlight
    sheenColor: new THREE.Color(PALETTE.sheen),
    specularIntensity: 0.16,
  }),
  Scarf: () => new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    sheen: 0.8,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(PALETTE.scarfSheen),
    specularIntensity: 0.2,
  }),
  Eye: () => new THREE.MeshPhysicalMaterial({
    color: PALETTE.eye, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.04, specularIntensity: 0.6,
  }),
  EyeHighlight: () => new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.4, emissive: 0xffffff, emissiveIntensity: 0.6,
  }),
  Line: () => new THREE.MeshStandardMaterial({ color: PALETTE.line, roughness: 0.55 }),
  Nose: () => new THREE.MeshPhysicalMaterial({
    color: PALETTE.nose, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1,
  }),
  MouthInside: () => new THREE.MeshStandardMaterial({ color: PALETTE.mouthInside, roughness: 0.6 }),
  Tongue: () => new THREE.MeshPhysicalMaterial({
    color: PALETTE.tongue, roughness: 0.5, sheen: 0.3, sheenColor: new THREE.Color(0xffffff),
  }),
  LogoCube: () => new THREE.MeshPhysicalMaterial({
    color: PALETTE.logoCube, roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.3,
    specularIntensity: 0.4, sheen: 0.25, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff),
    emissive: 0xffc9a0, emissiveIntensity: 0,
  }),
  LogoStar: () => new THREE.MeshPhysicalMaterial({
    color: PALETTE.logoStar, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.15,
    specularIntensity: 0.5, emissive: 0xff8a40, emissiveIntensity: 0,
  }),
};

// ---------------------------------------------------------------------------------------------
// Shader snippets

const NOISE_GLSL = /* glsl */ `
varying vec3 vRestPos;
uniform float uGrainScale;
uniform float uGrainStrength;
uniform float uMottle;
float furHash( vec3 p ) {
  p = fract( p * 0.3183099 + 0.1 );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float furNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( furHash( i ), furHash( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( furHash( i + vec3( 0, 1, 0 ) ), furHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( furHash( i + vec3( 0, 0, 1 ) ), furHash( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( furHash( i + vec3( 0, 1, 1 ) ), furHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
// Bump from a screen-space height gradient (same idea as three's perturbNormalArb).
vec3 furPerturbNormal( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
  vec3 sx = normalize( dFdx( surfPos ) );
  vec3 sy = normalize( dFdy( surfPos ) );
  vec3 r1 = cross( sy, surfNorm );
  vec3 r2 = cross( surfNorm, sx );
  float det = dot( sx, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surfNorm - grad );
}
`;

// Flocked grain: noise evaluated on the rest-pose position, so it sticks to the surface while
// skinned. The gradient is normalised by the noise footprint and faded out once a noise cell
// gets smaller than about a pixel (distance fade, no shimmering).
const GRAIN_GLSL = /* glsl */ `
{
  vec3 q = vRestPos * uGrainScale;
  float h = furNoise( q ) * 0.65 + furNoise( q * 2.31 + 11.7 ) * 0.35;
  float fw = max( length( fwidth( q ) ), 1e-4 );
  float grainFade = 1.0 - smoothstep( 0.45, 1.1, fw );
  vec2 dh = vec2( dFdx( h ), dFdy( h ) ) / fw;
  normal = furPerturbNormal( - vViewPosition, normal, dh * uGrainStrength * grainFade, faceDirection );
  diffuseColor.rgb *= 1.0 + ( h - 0.5 ) * uMottle * grainFade;
}
`;

function addSurfaceShader(material, { grain, ao, knitShade }) {
  material.userData.uniforms = {
    uGrainScale: { value: grain?.scale ?? 1 },
    uGrainStrength: { value: grain?.strength ?? 0 },
    uMottle: { value: grain?.mottle ?? 0 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.uniforms);
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    vs = vs.replace('#include <common>', `#include <common>
attribute vec3 restPos;
varying vec3 vRestPos;
#ifdef FUR_AO
attribute float furAO;
varying float vFurAO;
#endif`);
    vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>
vRestPos = restPos;
#ifdef FUR_AO
vFurAO = furAO;
#endif`);
    fs = fs.replace('#include <common>', `#include <common>
${NOISE_GLSL}
#ifdef FUR_AO
varying float vFurAO;
#endif`);
    if (grain) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${GRAIN_GLSL}`);
    if (knitShade) {
      // Knit height lives in the normal map's alpha: darken the grooves between stitches.
      fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
diffuseColor.rgb *= mix( 0.84, 1.0, texture2D( normalMap, vNormalMapUv ).a );`);
    }
    if (ao) {
      fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= vFurAO;
reflectedLight.indirectSpecular *= vFurAO;
#ifdef USE_SHEEN
sheenSpecularIndirect *= vFurAO;
#endif`);
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  if (ao) material.defines = { ...material.defines, FUR_AO: '' };
  material.customProgramCacheKey = () => `fox-surface-${!!grain}-${!!ao}-${!!knitShade}`;
}

// ---------------------------------------------------------------------------------------------
// Tileable knit normal map (stockinette "V" stitches). RGB = normal, A = height.

function makeKnitTexture(size = 256, cols = 8, rows = 10) {
  const hgt = new Float32Array(size * size);
  const cw = size / cols;
  const ch = size / rows;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = (x % cw) / cw; // 0..1 inside the stitch cell
      const cy = (y % ch) / ch;
      let best = 0;
      // Each stitch = two slanted leg lobes meeting at the bottom centre; sample the
      // neighbouring row too so legs overlap across cell borders like real knit.
      for (const oy of [0, 1]) {
        const ly = cy + oy; // lobes span 1.4 cells vertically
        for (const side of [-1, 1]) {
          const px = cx - 0.5 - side * 0.22 * (1.0 - (ly - 0.2) / 1.2);
          const py = ly - 0.7;
          // rotate into the leg's frame (legs slant ~25deg)
          const a = side * 0.45;
          const u = px * Math.cos(a) - py * Math.sin(a);
          const v = px * Math.sin(a) + py * Math.cos(a);
          const d = (u / 0.2) ** 2 + (v / 0.62) ** 2;
          if (d < 1) {
            const twist = 0.08 * Math.sin((v * 9 + u * 4) * Math.PI);
            best = Math.max(best, Math.sqrt(1 - d) * (0.92 + twist));
          }
        }
      }
      hgt[y * size + x] = best;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => hgt[((y + size) % size) * size + ((x + size) % size)];
  const k = 2.2;
  const n = new THREE.Vector3();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * k;
      const dy = (at(x, y + 1) - at(x, y - 1)) * k;
      n.set(-dx, dy, 1).normalize(); // canvas y grows downward, uv v grows upward
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = at(x, y) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.repeat.set(...SURFACE.knitRepeat);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------------

function baseName(name = '') {
  return name.replace(/\.\d+$/, '');
}

export function createMaterialLibrary({ anisotropy = 4 } = {}) {
  const cache = new Map();
  let knit = null;

  function build(name, geometry) {
    const hasColor = !!geometry?.attributes.color;
    const hasAO = !!geometry?.attributes.furAO;
    const hasUV = !!geometry?.attributes.uv;
    const hasRest = !!geometry?.attributes.restPos;
    const key = `${name}|${hasColor}|${hasAO}|${hasUV}|${hasRest}`;
    if (cache.has(key)) return cache.get(key);

    const mat = DEFS[name]();
    mat.name = name;
    if (mat.vertexColors && !hasColor) mat.vertexColors = false; // avoid black from a missing attribute
    if (name === 'Fur' && hasRest) {
      addSurfaceShader(mat, {
        grain: { scale: SURFACE.furGrainScale, strength: SURFACE.furGrainStrength, mottle: SURFACE.furMottle },
        ao: hasAO,
      });
    } else if (name === 'Scarf') {
      if (hasUV) {
        knit ??= makeKnitTexture();
        knit.anisotropy = anisotropy;
        mat.normalMap = knit;
        mat.normalScale.set(SURFACE.knitNormalScale, SURFACE.knitNormalScale);
      }
      if (hasRest || hasUV) {
        addSurfaceShader(mat, {
          grain: hasUV ? null : { scale: SURFACE.scarfGrainScale, strength: 0.12, mottle: 0.04 },
          ao: hasAO,
          knitShade: hasUV,
        });
      }
    }
    cache.set(key, mat);
    return mat;
  }

  return {
    /** Material for a glTF material name, or null when the name is not ours. */
    get(name, geometry) {
      const n = baseName(name);
      return DEFS[n] ? build(n, geometry) : null;
    },
    all: () => [...cache.values()],
  };
}
