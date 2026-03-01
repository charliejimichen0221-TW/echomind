import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface Elena3DProps {
  isSpeaking: boolean;
  volume: number;
}

export const Elena3D: React.FC<Elena3DProps> = ({ isSpeaking, volume }) => {
  const headRef = useRef<THREE.Group>(null);
  const mouthRef = useRef<THREE.Mesh>(null);
  const eyesRef = useRef<THREE.Group>(null);

  // Normalize volume for animation
  const normalizedVolume = Math.min(volume * 15, 1);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();

    if (headRef.current) {
      // Subtle idle breathing/swaying
      headRef.current.position.y = Math.sin(t * 0.5) * 0.05;
      headRef.current.rotation.y = Math.sin(t * 0.2) * 0.05;
      
      if (isSpeaking) {
        // More active movement when speaking
        headRef.current.rotation.x = Math.sin(t * 10) * 0.02 * normalizedVolume;
      }
    }

    if (mouthRef.current) {
      if (isSpeaking) {
        // Mouth opening based on volume
        mouthRef.current.scale.y = 0.1 + normalizedVolume * 2;
        mouthRef.current.position.y = -0.4 - (normalizedVolume * 0.1);
      } else {
        mouthRef.current.scale.y = 0.1;
        mouthRef.current.position.y = -0.4;
      }
    }

    if (eyesRef.current) {
      // Occasional blinking
      const blink = Math.sin(t * 0.5) > 0.98 ? 0.1 : 1;
      eyesRef.current.scale.y = THREE.MathUtils.lerp(eyesRef.current.scale.y, blink, 0.2);
    }
  });

  return (
    <group ref={headRef}>
      {/* Face/Head - Stylized Sphere */}
      <mesh castShadow>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial color="#f5d0c0" roughness={0.3} />
      </mesh>

      {/* Hair - Stylized Blonde */}
      <mesh position={[0, 0.5, -0.2]} scale={[1.1, 0.8, 1.1]}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial color="#fdf1b8" roughness={0.5} />
      </mesh>

      {/* Eyes */}
      <group ref={eyesRef} position={[0, 0.2, 0.8]}>
        <mesh position={[-0.3, 0, 0]}>
          <sphereGeometry args={[0.1, 16, 16]} />
          <meshStandardMaterial color="#222" />
        </mesh>
        <mesh position={[0.3, 0, 0]}>
          <sphereGeometry args={[0.1, 16, 16]} />
          <meshStandardMaterial color="#222" />
        </mesh>
      </group>

      {/* Mouth */}
      <mesh ref={mouthRef} position={[0, -0.4, 0.9]}>
        <boxGeometry args={[0.4, 0.1, 0.1]} />
        <meshStandardMaterial color="#833" />
      </mesh>

      {/* Glasses/Tech Detail */}
      <mesh position={[0, 0.2, 0.75]}>
        <boxGeometry args={[1.2, 0.05, 0.1]} />
        <meshStandardMaterial color="#10b981" emissive="#10b981" emissiveIntensity={2} transparent opacity={0.5} />
      </mesh>
    </group>
  );
};
