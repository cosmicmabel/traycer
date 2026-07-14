import { visit } from "unist-util-visit";
import type { Root, Element } from "hast";
import { CIC_EPIC_TAG } from "./const";
import { extractTextContent, pickStringProp } from "./hast-utils";

export function rehypeCicEpic() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== CIC_EPIC_TAG) {
        return;
      }

      const epicId = pickStringProp(node.properties, "epicid", "epicId");
      const title = pickStringProp(node.properties, "title");

      if (epicId === undefined) {
        return;
      }

      const displayText = extractTextContent(node.children).trim();
      if (!displayText) {
        return;
      }

      node.tagName = CIC_EPIC_TAG;
      node.properties = {
        "data-epic-id": epicId,
      };

      if (title !== undefined) {
        node.properties["data-title"] = title;
      }
    });

    return tree;
  };
}
