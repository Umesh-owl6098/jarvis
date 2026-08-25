'use client';

import { Canvas } from '@react-three/fiber';
import { EffectComposer, Bloom, Vignette, Noise } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { Suspense, useEffect, useState } from 'react';
import * as THREE from 'three';
import { JarvisCore3D, type SceneQuality } from './JarvisCore3D';
import { type VisualState } from './types';

interface JarvisSceneProps {
  state: VisualState;
  quality?: SceneQuality;
}

export function JarvisScene({ state, quality = 'high' }: JarvisSceneProps) {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const light = quality === 'low';

  return (
    <Canvas
      camera={{ position: [0, 0.35, 7.4], fov: 42, near: 0.1, far: 60 }}
      style={{ width: '100%', height: '100%' }}
      gl={{
        antialias: false, // FXAA-free; bloom + composer handle edges, and MSAA is costly here
        alpha: false,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 0.95,
      }}
      dpr={light ? [1, 1.25] : [1, 1.75]}
      onCreated={({ gl }) => gl.setClearColor(0x04070d, 1)}
    >
      <Suspense fallback={null}>
        <JarvisCore3D state={state} quality={quality} reducedMotion={reducedMotion} />

        {/* Effects must live inside EffectComposer — outside it they are inert. */}
        <EffectComposer multisampling={0} enableNormalPass={false}>
          <Bloom
            mipmapBlur
            luminanceThreshold={0.34}
            luminanceSmoothing={0.5}
            intensity={light ? 0.5 : 0.72}
            radius={0.66}
          />
          <Vignette eskil={false} offset={0.22} darkness={0.82} />
          {light ? <></> : <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.18} />}
        </EffectComposer>
      </Suspense>
    </Canvas>
  );
}
