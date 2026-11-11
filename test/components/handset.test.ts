import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import Handset from "../../src/components/Handset.astro";

/** La section des fonctionnalités : son titre, son introduction, ses trois moments dans l'ordre, la suite annoncée, et la photo du combiné. */

const text = (html: string): string => html.replace(/<[^>]*>/g, "").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;| /g, " ");

describe("the features section", () => {
  it("promises moments, then lists the handset, the frame and the filters in order", async () => {
    const html = await (await AstroContainer.create()).renderToString(Handset);
    expect(text(/<h2>[\s\S]*?<\/h2>/.exec(html)![0])).toBe("Des moments qui subliment votre événement");
    expect(text(/<p>[\s\S]*?<\/p>/.exec(html)![0])).toBe(
      "Au-delà des photos, la borne réserve d'autres surprises à vos invités. Chacune crée un moment à part, qui sublime votre événement.",
    );
    const items = [...html.matchAll(/<li>\s*<b>([\s\S]*?)<\/b>\s*<span>([\s\S]*?)<\/span>/g)].map(([, title, body]) => [text(title), text(body)]);
    expect(items).toEqual([
      ["Un combiné sur le côté", "Vos invités décrochent et se laissent des messages audio-vidéo, à écouter directement à la borne"],
      ["Un cadre à votre image", "Ajoutez-le à tout moment, même pendant l'événement : il apparaît sur les tirages"],
      ["Filtres et dessin", "Vos invités personnalisent leur photo à l'écran"],
    ]);
    expect(text(/<p class="more"[^>]*>[\s\S]*?<\/p>/.exec(html)![0])).toBe("Et ce n'est qu'un début : de nouvelles fonctionnalités arriveront, selon vos besoins.");
    expect(html.indexOf('class="more"')).toBeGreaterThan(html.indexOf("</ul>"));
    expect(html).toContain("alt=\"Le combiné et le bac d'impression sur le côté de la borne\"");
  });
});
