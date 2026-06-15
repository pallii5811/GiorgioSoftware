import { fetchAccreditedClinics } from "../src/lib/sanita/salute.ts";
import { getRegionCities } from "../src/lib/sanita/region-cities.ts";

const campania = await fetchAccreditedClinics("Campania");
const veneto = await fetchAccreditedClinics("Veneto");
const comuniC = getRegionCities("Campania");
const comuniV = getRegionCities("Veneto");

console.log(
  JSON.stringify(
    {
      fonteMinSalute: {
        campania: campania.length,
        veneto: veneto.length,
        totale: campania.length + veneto.length,
        nota: "Solo case di cura accreditate — sottoinsieme Gelli, fonte ufficiale",
      },
      comuniIstat: {
        campania: comuniC.length,
        veneto: comuniV.length,
        totale: comuniC.length + comuniV.length,
      },
      stimaMercatoGelli: {
        minimoCerto: campania.length + veneto.length,
        rangeRealistico: "1.200 – 2.800",
        rangeAlto: "fino ~3.500",
        nota: "Min.Salute + RSA/poliambulatori/cliniche non accreditate da Maps",
      },
    },
    null,
    2
  )
);
