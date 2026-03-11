/**
 * Generate a stylish SVG avatar for Coach Echo.
 * Uses lightweight local SVG generation instead of Gemini image API
 * to preserve API quota for the core Live API conversation.
 */
export async function generateDebaterImage(_topic?: string) {
  const avatars = [
    { initials: 'EC', gradient: ['#3B82F6', '#8B5CF6'], bg: '#1E1B4B' },  // Blue-violet
    { initials: 'AE', gradient: ['#06B6D4', '#3B82F6'], bg: '#0C1A3D' },  // Cyan-blue
    { initials: 'EM', gradient: ['#10B981', '#06B6D4'], bg: '#0D2B25' },  // Green-cyan
    { initials: 'ZR', gradient: ['#F59E0B', '#EF4444'], bg: '#2D1810' },  // Amber-red
    { initials: 'KL', gradient: ['#EC4899', '#8B5CF6'], bg: '#2D1535' },  // Pink-purple
  ];

  const avatar = avatars[Math.floor(Math.random() * avatars.length)];
  const [c1, c2] = avatar.gradient;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${avatar.bg}" />
          <stop offset="100%" stop-color="#0a0a0a" />
        </linearGradient>
        <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${c1}" />
          <stop offset="100%" stop-color="${c2}" />
        </linearGradient>
        <filter id="blur">
          <feGaussianBlur stdDeviation="20" />
        </filter>
      </defs>
      <rect width="200" height="200" fill="url(#bg)" />
      <circle cx="100" cy="80" r="60" fill="url(#glow)" opacity="0.15" filter="url(#blur)" />
      <circle cx="100" cy="80" r="35" fill="none" stroke="url(#glow)" stroke-width="2" opacity="0.6" />
      <circle cx="100" cy="68" r="14" fill="url(#glow)" opacity="0.8" />
      <path d="M 70 95 Q 100 120 130 95" fill="url(#glow)" opacity="0.5" />
      <text x="100" y="155" text-anchor="middle" fill="url(#glow)" font-family="system-ui,sans-serif" font-size="14" font-weight="bold" letter-spacing="4" opacity="0.9">COACH</text>
      <text x="100" y="175" text-anchor="middle" fill="white" font-family="system-ui,sans-serif" font-size="11" font-weight="600" letter-spacing="6" opacity="0.4">ECHO</text>
    </svg>
  `.trim();

  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
