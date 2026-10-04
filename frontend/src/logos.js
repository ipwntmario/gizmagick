export const LOGO_VARIANTS = [
  { id: "dark-indigo-gold-ring", label: "Dark — indigo with gold ring", src: "/branding/gizmagick-logo-color.png" },
  { id: "dark-indigo", label: "Dark — indigo", src: "/branding/gizmagick-logo-dark-indigo.png" },
  { id: "original", label: "Original full color", src: "/branding/gizmagick-logo-color-original.png" },
  { id: "dark-gold", label: "Dark — gold ribbon", src: "/branding/gizmagick-logo-dark-gold.png" },
  { id: "white", label: "Monochrome — white", src: "/branding/gizmagick-logo-white.svg" },
  { id: "black", label: "Monochrome — black", src: "/branding/gizmagick-logo-black.svg" },
];

export function resolveLogo(id) {
  const compatibleId = id === "indigo-gold-ring" ? "dark-indigo-gold-ring" : id;
  return LOGO_VARIANTS.find((logo) => logo.id === compatibleId) || LOGO_VARIANTS[0];
}
