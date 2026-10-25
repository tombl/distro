/** The rendezvous hub origin the server put in the page's `<meta name="hub">`. */
export const hubOrigin = document.querySelector<HTMLMetaElement>('meta[name="hub"]')!.content;
