import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';

if (env.CLOUDINARY_URL) {
  cloudinary.config({ cloudinary_url: env.CLOUDINARY_URL });
} else {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
}

export const uploadBuffer = ({ buffer, folder, publicId, resourceType = 'image' }) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: resourceType },
      (error, result) => {
        if (error) reject(error);
        else resolve({ secureUrl: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });

export const deleteImage = async (publicId) => {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId);
};

// Recover the public id from a stored secure URL, for deleting an asset we only kept the
// URL of. Cloudinary URLs look like
// https://res.cloudinary.com/<cloud>/image/upload/v1712345678/<folder>/<name>.jpg
// with the version segment optional; the public id is everything after it, extension
// stripped. Returns null for anything that isn't a Cloudinary upload URL.
export const extractPublicId = (url) =>
  (typeof url === 'string' ? url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/)?.[1] : null) ?? null;

export { cloudinary };
