import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeBio } from "../src/extract.ts";

test("looksLikeBio catches author blurbs", () => {
  const cases: [string, string | null][] = [
    ["Ismar is a Senior Author at How-To Geek. He previously worked as a writer, editor, and general manager.", "Ismar Hrnjicevic"],
    ["Umair Khurshid is a technology writer and developer with a strong focus on Linux.", "Umair Khurshid"],
    ["Patrick Campanale has been in the tech space for well over a decade, specializing in PC news.", "Patrick Campanale"],
    ["Mahnoor Faisal is a tech journalist covering AI and productivity tools with bylines at XDA.", null],
    ["Jane is an editor who has covered consumer tech since 2010.", "staff@bgr.com (Jane Doe)"],
  ];
  for (const [text, author] of cases) assert.equal(looksLikeBio(text, author), true, text);
});

test("looksLikeBio leaves article text alone", () => {
  const cases: [string, string | null][] = [
    ["Zach Yadegari has enjoyed an immense amount of success for someone who only recently graduated.", "Lucas Ropek"],
    ["Days after a journalist claimed that Meta's Muse app read their private messages, Apple acted.", "Sarah Perez"],
    ["Christian Schaller, a Red Hat engineering director and longtime GNOME contributor, had a box of negatives.", "Amanda Caswell"],
    ["Back in 2017, when NVMe SSDs were still new and incredibly expensive, Intel introduced Optane.", "Ismar Hrnjicevic"],
    ["Kubernetes is a container orchestrator, and this release changes how it schedules pods.", null],
  ];
  for (const [text, author] of cases) assert.equal(looksLikeBio(text, author), false, text);
});
