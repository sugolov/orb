// Ported from orb-shell.html. Fresnel rim + multi-octave noise haze, with an
// optional uChaos lightning effect for working orbs.
//
// Uniforms:
//   uTime      — seconds since scene start
//   uIntensity — overall brightness multiplier
//   uColor     — base color of the orb
//   uChaos     — 0..1, ramps the lightning shader on top

export const orbVert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    vN = normalize(normalMatrix * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const orbFrag = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColor;
  uniform float uChaos;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vLocal;

  float hash(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z
    );
  }

  void main() {
    float fres = pow(1.0 - max(dot(vN, vView), 0.0), 2.2);
    float n  = noise(vLocal * 3.0 + uTime * 0.3);
    float n2 = noise(vLocal * 6.0 - uTime * 0.5);
    float haze = smoothstep(0.4, 1.0, n * 0.6 + n2 * 0.4) * 0.5;
    float bright = (fres * 1.7 + haze) * uIntensity;
    float a = clamp(fres * 0.9 + haze * 0.55 + 0.1, 0.0, 1.0);

    vec3 finalColor = uColor;
    if (uChaos > 0.001) {
      float c1 = noise(vLocal * 4.0  + vec3(uTime * 4.5));
      float c2 = noise(vLocal * 9.0  - vec3(uTime * 7.2));
      float c3 = noise(vLocal * 17.0 + vec3(uTime * 10.5));
      float crackle = pow(smoothstep(0.55, 1.0, (c1 + 0.5 * c2 + 0.25 * c3) / 1.75), 1.4);
      float strobeT = floor(uTime * 14.0);
      float strobe = step(0.55, fract(sin(strobeT * 12.9898) * 43758.5453));
      float bolt = step(0.92, c2) * step(0.6, c3) * strobe;
      float burst = (crackle * strobe + bolt * 1.5) * uChaos;
      bright += burst * 4.5;
      finalColor = mix(uColor, vec3(1.0), clamp(burst * 0.9, 0.0, 1.0));
      a = clamp(a + burst * 0.5, 0.0, 1.0);
    }

    gl_FragColor = vec4(finalColor * bright, a);
  }
`;
