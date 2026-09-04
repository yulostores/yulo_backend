import qrcode from 'qrcode';
import { cloudinary } from './upload.service.js';
import Table from '../models/Table.js';
import { env } from '../config/env.js';

export const generateTableQR = async ({ restaurantId, tableId, tableNumber, baseUrl }) => {
  // Query-string-only landing — the guest app (yulo_menu) reads ?r=&t= off its root route,
  // so this never depends on a specific client-side path existing. The previous
  // `/menu?restaurantId=&tableId=` shape pointed at a route yulo_restaurant's SPA never
  // actually had, which bounced every scan to its owner-login screen.
  const menuUrl = `${baseUrl}/?r=${restaurantId}&t=${tableId}`;

  const dataUrl = await qrcode.toDataURL(menuUrl, { width: 300, margin: 2 });

  let imageUrl = null;
  if (env.CLOUDINARY_CLOUD_NAME) {
    try {
      const result = await cloudinary.uploader.upload(dataUrl, {
        folder: `yulostores/qr/${restaurantId}`,
        public_id: `table_${tableNumber}_${Date.now()}`,
      });
      imageUrl = result.secure_url;
    } catch {
      // Cloudinary optional — fall back to data URL
    }
  }

  await Table.findByIdAndUpdate(tableId, {
    'qrCode.url': menuUrl,
    'qrCode.imageUrl': imageUrl || dataUrl,
    'qrCode.status': 'active',
    'qrCode.generatedAt': new Date(),
  });

  return { url: menuUrl, imageUrl: imageUrl || dataUrl, tableNumber, qrDataUrl: dataUrl };
};
