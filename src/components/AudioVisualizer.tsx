import React from 'react';
import { motion } from 'motion/react';

interface AudioVisualizerProps {
  isActive: boolean;
  color?: string;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ isActive, color = "#10b981" }) => {
  return (
    <div className="flex items-center justify-center gap-1 h-12">
      {[...Array(12)].map((_, i) => (
        <motion.div
          key={i}
          className="w-1.5 rounded-full"
          style={{ backgroundColor: color }}
          animate={isActive ? {
            height: [10, Math.random() * 40 + 10, 10],
          } : {
            height: 4,
          }}
          transition={isActive ? {
            duration: 0.5 + Math.random() * 0.5,
            repeat: Infinity,
            ease: "easeInOut",
          } : {
            duration: 0.2
          }}
        />
      ))}
    </div>
  );
};
