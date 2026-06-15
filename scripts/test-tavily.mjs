/**
 * Test diretto della verifica regionale con Tavily.
 * Non dipende da Overpass.
 */

const { checkRegionalPolicy } = await import("../src/lib/sanita/regional-check.ts");

const testName = "Ospedale San Raffaele";
const testCity = "Milano";
const testRegion = "Lombardia";

console.log("Testing Tavily regional check...");
console.log("Facility:", testName, "in", testCity);

try {
  const result = await checkRegionalPolicy(testName, testCity, testRegion);
  console.log("\n=== RISULTATO ===");
  console.log("policyFound:", result.policyFound);
  console.log("evidence:", result.evidence);
  console.log("confidence:", result.confidence);
  console.log("\n✓ Tavily API risponde correttamente!");
} catch (err) {
  console.error("\n✗ ERRORE Tavily:", err.message);
}
