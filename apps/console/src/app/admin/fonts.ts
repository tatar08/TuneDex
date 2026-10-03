import { Bai_Jamjuree, Chakra_Petch, IBM_Plex_Mono, IBM_Plex_Sans_Thai, JetBrains_Mono, Noto_Sans_Thai, Prompt, Share_Tech_Mono } from 'next/font/google';

// Self-hosted at build time by next/font, so staff browsers never call Google Fonts.
// Each theme uses only its own families; unused ones are never downloaded.
export const notoThai = Noto_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['300', '400', '500', '600'], variable: '--f-noto', display: 'swap', preload: false });
export const plexThai = IBM_Plex_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['400', '500', '600'], variable: '--f-plex', display: 'swap', preload: false });
export const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--f-plex-mono', display: 'swap', preload: false });
export const chakra = Chakra_Petch({ subsets: ['thai', 'latin'], weight: ['400', '500', '600', '700'], variable: '--f-chakra', display: 'swap', preload: false });
export const shareTech = Share_Tech_Mono({ subsets: ['latin'], weight: '400', variable: '--f-share', display: 'swap', preload: false });
export const prompt = Prompt({ subsets: ['thai', 'latin'], weight: ['400', '500', '600'], variable: '--f-prompt', display: 'swap', preload: false });
export const bai = Bai_Jamjuree({ subsets: ['thai', 'latin'], weight: ['400', '500', '600'], variable: '--f-bai', display: 'swap', preload: false });
export const jetbrains = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--f-jb', display: 'swap', preload: false });

export const fontVariables = [notoThai, plexThai, plexMono, chakra, shareTech, prompt, bai, jetbrains].map((f) => f.variable).join(' ');
