export function slugify(text: string) {
  return text
    .normalize("NFKD") // Normalize to decomposed form.
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics.
    .replace(/([a-z])([A-Z0-9])/g, "$1_$2") // Get all lowercase letters that are near to uppercase ones and replace with _.
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_") // Replace spaces with _.
    .replace(/[\W]+/g, "_") // Replace all non-word characters with _.
    .replace(/__+/g, "_"); // Replace multiple _ with single _.
}
