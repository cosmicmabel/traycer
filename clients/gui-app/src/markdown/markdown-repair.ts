import remend from "remend";
import { repairCicNextStepsMarkdown } from "./cic-next-steps";

export function repairMarkdown(content: string): string {
  return remend(content, {
    handlers: [
      {
        name: "cic-next-steps",
        priority: 10,
        handle: repairCicNextStepsMarkdown,
      },
      {
        name: "code-fence",
        priority: 11,
        handle: repairCodeFences,
      },
    ],
  });
}

function repairCodeFences(text: string): string {
  const lines = text.split("\n");
  let openFence: string | null = null;

  for (const line of lines) {
    const indentMatch = line.match(/^( {0,3})(`{3,}|~{3,})/);

    if (openFence === null) {
      if (indentMatch) {
        openFence = indentMatch[2][0].repeat(indentMatch[2].length);
      }
    } else {
      if (indentMatch) {
        const fenceChar = openFence[0];
        const fenceLen = openFence.length;
        const candidate = indentMatch[2];
        if (
          candidate[0] === fenceChar &&
          candidate.length >= fenceLen &&
          line.trimEnd() === indentMatch[1] + candidate
        ) {
          openFence = null;
        }
      }
    }
  }

  if (openFence !== null) {
    return text + "\n" + openFence;
  }

  return text;
}
