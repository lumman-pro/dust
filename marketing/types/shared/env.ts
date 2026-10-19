export function isDevelopment() {
  return (
    process.env.NODE_ENV === "development" ||
    process.env.IS_DEVELOPMENT === "true"
  );
}
