import { GoogleGenAI } from "@google/genai";

export async function generateDebaterImage(topic?: string) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  const personas = [
    "A professional and intelligent-looking blonde woman in her 30s, wearing a smart business suit",
    "A sharp-looking man in his 40s with glasses and a salt-and-pepper beard, wearing a formal vest",
    "A young, energetic woman of Asian descent in her 20s, wearing a modern blazer and a confident smile",
    "A distinguished-looking elderly man with white hair and a kind but firm expression, in a traditional academic robe",
    "A professional man of African descent in his 30s, with a clean-cut look and a focused gaze, wearing a crisp white shirt"
  ];

  const randomPersona = personas[Math.floor(Math.random() * personas.length)];
  const prompt = `${randomPersona}, sitting in a modern debate hall or library setting. High quality, cinematic lighting, realistic style, portrait shot, looking at camera.`;
  
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: prompt }],
      },
      config: {
        imageConfig: {
          aspectRatio: "1:1",
        },
      },
    });

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  } catch (error) {
    console.error("Error generating image:", error);
    return null;
  }
  return null;
}
