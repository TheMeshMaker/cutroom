// Editor context: the project, edit/undo plumbing, selection and the actions
// every panel shares.
import { createContext, useContext } from "react";

export const EditorContext = createContext(null);
export const useEditor = () => useContext(EditorContext);

export const EMPTY_SELECTION = { clips: [], bleep: null, markers: [], transition: null };
