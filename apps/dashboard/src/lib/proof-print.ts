/** Prints one image by itself. */
export function printImage(dataUrl: string): void {
  const sheet = document.createElement('div');
  sheet.className = 'proof-print-sheet';
  const img = document.createElement('img');
  img.alt = 'Proof of mint';
  img.src = dataUrl;
  sheet.appendChild(img);
  document.body.appendChild(sheet);
  document.body.classList.add('printing-proof');
  const cleanup = () => {
    document.body.classList.remove('printing-proof');
    sheet.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  const go = () => window.print();
  if (img.complete) go();
  else img.onload = go;
}
