/**
 * Fixture anonimizzata — Scheda di Polizza AmTrust-like (tabella PDF).
 * Contiene decorrenza, scadenza, quietanza, numero, contraente.
 * NON usare quietanza come expiry.
 */
export const SCHEDA_POLIZZA_FIXTURE_ANON = `
RCI00010002744                         -                                 AmTrust Istituti Clinici - Ed.03/2020 Agg.03/2024

Dati del Contraente / Assicurato

                               CASA DI CURA ESEMPIO SRL                                                      01234567890               01234567890

             VIA ESEMPIO, 1                                                ROMA                                    RM     00100           IT

Periodo di Assicurazione

            31/12/2024                             31/12/2025                                                        Sì

                                Fatturato                                                        Tasso           di Regolazione

                            5.510.000,00                                                                      6,9611

 Dati di pagamento

                             Semestrale                                                                    30/06/2025

 Premio alla Firma

            20.145,60                           0,00                     20.145,60                       4.482,40                      24.628,00

AmTrust Istituti Clinici– Ed. 03/2020 – Scheda di Polizza | pagina 1 di 10
`;

/** Variante con etichetta esplicita "Scade alle ore 24 del". */
export const SCHEDA_POLIZZA_FIXTURE_SCADE24 = `
Polizza N°: RCI00010002744
Contraente: CASA DI CURA ESEMPIO SRL
Decorrenza: 31/12/2024
Scade alle ore 24 del 31/12/2025
Tacito rinnovo: Sì
Prossima quietanza: 30/06/2025
Compagnia: AmTrust
`;
