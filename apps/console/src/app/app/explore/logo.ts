/** The station's own logo, else TuneDeck's, always from this site (the page loads images from nowhere else). */
export const logoSrc = (s: { id: string; logoVersion?: string }) => (s.logoVersion ? `/bff/logos/stations/${s.id}?v=${s.logoVersion}` : '/bff/logos/default');
