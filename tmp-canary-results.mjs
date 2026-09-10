#!/usr/bin/env node
import { readFileSync } from "node:fs";
const ids = [
  "cmrukbcco0002126387vm7gse",
  "cmqktyimz000i111hygme29nh",
  "cmqklex5q00bh108eq9blm01k",
];
const res = await fetch("http://168.119.253.47:3000/api/sanita?region=Campania&includeAll=1");
const j = await res.json();
const data = j.data || [];
for (const id of ids) {
  const l = data.find((x) => x.id === id);
  if (!l) {
    console.log(id, "NOT_FOUND");
    continue;
  }
  const ps = l.semantic?.processingState || (l.evidence || "").match(/\[STATE:([^\]]+)\]/)?.[1] || "?";
  const bv = l.semantic?.businessVerdict || "?";
  const actionable = Boolean(l._actionable ?? l.semantic?.actionable);
  console.log(JSON.stringify({ id, name: l.companyName, city: l.city, ps, bv, actionable, status: l.status, notesLen: (l.notes || "").length }));
}
