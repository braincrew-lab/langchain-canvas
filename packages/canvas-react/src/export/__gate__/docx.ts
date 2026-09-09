import { Packer } from "docx";
import { documentToDocxDocument } from "../exporters";
(window as unknown as { buildDocx: (content: string) => Promise<string> }).buildDocx = async (content) =>
  Packer.toBase64String(await documentToDocxDocument({ format: "markdown", content }));
