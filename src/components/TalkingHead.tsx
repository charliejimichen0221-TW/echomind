import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { User } from 'lucide-react';
import { cn } from '../utils/cn';

interface TalkingHeadProps {
  image: string | null;
  isSpeaking: boolean;
  volume: number;
}

export const TalkingHead: React.FC<TalkingHeadProps> = ({ image, isSpeaking, volume }) => {
  const [isBlinking, setIsBlinking] = useState(false);

  // Normalize volume for animation (0 to 1)
  const normalizedVolume = Math.min(volume * 12, 1);

  // Blinking logic
  useEffect(() => {
    const blinkRandomly = () => {
      const timeout = Math.random() * 4000 + 2000;
      setTimeout(() => {
        setIsBlinking(true);
        setTimeout(() => setIsBlinking(false), 150);
        blinkRandomly();
      }, timeout);
    };
    blinkRandomly();
  }, []);

  return (
    <div className="relative w-full h-full overflow-hidden bg-black">
      {image ? (
        <motion.div 
          className="relative w-full h-full"
          animate={{
            y: [0, -4, 0],
            scale: isSpeaking ? 1.02 : 1,
          }}
          transition={{
            y: { duration: 4, repeat: Infinity, ease: "easeInOut" },
            scale: { duration: 0.5 }
          }}
        >
          {/* Main Image */}
          <img 
            src={image} 
            alt="Elena" 
            className={cn(
              "w-full h-full object-cover transition-all duration-1000",
              isSpeaking ? "brightness-110 contrast-105" : "brightness-90 contrast-100"
            )} 
          />
          
          {/* Eye Blinking Overlay */}
          {/* We use a heuristic position for eyes on a 1:1 portrait (around 40% from top) */}
          <div className="absolute top-[38%] left-0 w-full flex justify-center gap-[18%] pointer-events-none">
            <motion.div 
              animate={{ scaleY: isBlinking ? 1 : 0 }}
              className="w-[8%] h-[2%] bg-[#2a1a14] rounded-full origin-top"
            />
            <motion.div 
              animate={{ scaleY: isBlinking ? 1 : 0 }}
              className="w-[8%] h-[2%] bg-[#2a1a14] rounded-full origin-top"
            />
          </div>

          {/* Dynamic Lighting / Bloom */}
          <AnimatePresence>
            {isSpeaking && (
              <>
                {/* Outer Glow Aura */}
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ 
                    opacity: [0.1, 0.3, 0.1],
                    scale: [1, 1.05, 1]
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                    ease: "easeInOut"
                  }}
                  className="absolute inset-0 bg-emerald-500/5 blur-2xl rounded-full pointer-events-none"
                />
                
                {/* Reactive Surface Lighting */}
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: normalizedVolume * 0.5 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-gradient-to-t from-emerald-400/20 via-transparent to-transparent mix-blend-screen pointer-events-none"
                />

                {/* Subtle Scanline Effect when speaking */}
                <div className="absolute inset-0 bg-[linear-gradient(rgba(16,185,129,0)_50%,rgba(16,185,129,0.1)_50%)] bg-[length:100%_4px] pointer-events-none opacity-20" />
              </>
            )}
          </AnimatePresence>

          {/* Subtle Head Tilt */}
          <motion.div 
            className="absolute inset-0 pointer-events-none"
            animate={{
              rotate: isSpeaking ? Math.sin(Date.now() / 200) * normalizedVolume * 0.5 : 0
            }}
          />
        </motion.div>
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-zinc-900">
          <div className="flex flex-col items-center gap-4">
            <User className="w-16 h-16 text-zinc-800 animate-pulse" />
            <span className="text-[10px] text-zinc-700 font-mono tracking-widest uppercase">Initializing Persona...</span>
          </div>
        </div>
      )}
    </div>
  );
};
