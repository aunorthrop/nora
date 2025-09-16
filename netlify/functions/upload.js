import { isAdmin, addDoc } from "./_shared/store.js";
import pdfParse from "pdf-parse";

const hdrs = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*
