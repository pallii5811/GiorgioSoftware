/**
 * Regional identity — territory contamination and hotel mismatch (general rules).
 */
import { resolveRegionalIdentity, territoryConflict } from "../src/lib/sanita/regional-identity.ts";

const start = Date.now();
let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) {
    pass++;
    console.log(`  ✓ ${m}`);
  } else {
    fail++;
    console.error(`  ✗ ${m}`);
  }
}

ok(!territoryConflict({ claimedRegion: "Veneto", city: "Palermo" }).ok, "Palermo≠Veneto");
ok(!territoryConflict({ claimedRegion: "Campania", city: "Zingonia" }).ok, "Zingonia≠Campania");
ok(!territoryConflict({ claimedRegion: "Veneto", city: "Oppido Mamertina" }).ok, "Oppido≠Veneto");
ok(territoryConflict({ claimedRegion: "Campania", city: "Napoli" }).ok, "Napoli=Campania");

const hotel = resolveRegionalIdentity({
  companyName: "Clinica Sole",
  city: "Napoli",
  region: "Campania",
  website: "https://hotel-sole.it",
  siteText: "Benvenuti nel nostro hotel 4 stelle con spa",
});
ok(hotel.status === "MISMATCH", "hotel site → MISMATCH");

const omonimo = resolveRegionalIdentity({
  companyName: "Casa di Cura Aurora",
  city: "Verona",
  region: "Veneto",
  website: "https://aurora-altroente.it",
  siteText: "Omonimia: altra ragione sociale diversa — non la clinica",
});
ok(omonimo.status === "MISMATCH" || omonimo.status === "INSUFFICIENT", "omonimia not confirmed");

const okId = resolveRegionalIdentity({
  companyName: "Casa di Cura Aurora",
  city: "Verona",
  region: "Veneto",
  website: "https://aurora-verona.it",
  vatId: "01234567890",
  phone: "0451234567",
  siteText: "<title>Casa di Cura Aurora Verona</title> P.IVA 01234567890 tel 0451234567 Verona",
});
ok(okId.verified, `coherent facility → verified (${okId.status})`);

const group = resolveRegionalIdentity({
  companyName: "RSA Aurora Padova",
  city: "Padova",
  region: "Veneto",
  website: "https://gruppo-aurora.it/sedi/padova",
  vatId: "01234567890",
  groupSeatVerified: true,
  seatPageUrl: "https://gruppo-aurora.it/sedi/padova",
  siteText: "<title>RSA Aurora Padova</title> P.IVA 01234567890 Padova sede del gruppo",
});
ok(group.status === "GROUP_OFFICIAL_CONFIRMED" || group.verified, `group seat (${group.status})`);

const wrongSeat = resolveRegionalIdentity({
  companyName: "RSA Aurora Padova",
  city: "Padova",
  region: "Veneto",
  website: "https://gruppo-aurora.it",
  groupSeatVerified: false,
  siteText: "<title>Gruppo Aurora</title> sede Milano soltanto",
});
ok(!wrongSeat.verified || wrongSeat.status === "INSUFFICIENT", "group without seat not HOT/PUB grade");

console.log(
  JSON.stringify({
    suite: "regional-identity",
    exitCode: fail === 0 ? 0 : 1,
    durationMs: Date.now() - start,
    pass,
    fail,
    skipped: 0,
  }, null, 2)
);
process.exit(fail === 0 ? 0 : 1);
