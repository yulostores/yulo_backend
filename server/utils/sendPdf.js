/** Send a built PDF ({ buffer, filename }) as a download nobody caches. */
export const sendPdf = (res, { buffer, filename }) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
};
