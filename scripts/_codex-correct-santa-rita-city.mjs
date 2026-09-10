import { prisma } from "@/lib/prisma";

const result = await prisma.lead.updateMany({
  where: {
    type: "HEALTHCARE",
    region: "Calabria",
    companyName: "Casa Di Cura Privata S. Rita Srl",
    website: "https://www.casadicurasantarita.info/",
  },
  data: { city: "Cirò Marina" },
});

console.log(JSON.stringify({ updated: result.count, city: "Cirò Marina" }));
await prisma.$disconnect();
