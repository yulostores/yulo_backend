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

// Same, for assets that aren't images. `destroy` defaults to `resource_type: 'image'` and
// silently reports "not found" for a raw asset rather than deleting it, so anything stored
// outside the image type has to say so explicitly — otherwise every replaced PDF stays in
// Cloudinary forever while the API believes it reaped it.
export const deleteAsset = async (publicId, resourceType = 'image') => {
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
};

// Recover the public id from a stored secure URL, for deleting an asset we only kept the
// URL of. Cloudinary URLs look like
// https://res.cloudinary.com/<cloud>/image/upload/v1712345678/<folder>/<name>.jpg
// with the version segment optional; the public id is everything after it, extension
// stripped. Returns null for anything that isn't a Cloudinary upload URL.
export const extractPublicId = (url) =>
  (typeof url === 'string' ? url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/)?.[1] : null) ?? null;

export { cloudinary };

// Which Cloudinary resource type a stored delivery URL was served under —
// https://res.cloudinary.com/<cloud>/<resourceType>/upload/... — for documents saved
// before `resourceType` was recorded on them.
export const extractResourceType = (url) =>
  (typeof url === 'string' ? url.match(/res\.cloudinary\.com\/[^/]+\/([a-z]+)\/upload\//)?.[1] : null) ??
  'image';

// An api-key-signed URL to Cloudinary's download endpoint, for assets that plain delivery
// refuses to serve.
//
// Cloudinary accounts ship with "Allow delivery of PDF and ZIP files" switched OFF, and a
// PDF stored under the `image` resource type is then answered with `401 deny or ACL
// failure` on its own secure_url. Signing the *delivery* URL does not lift that, and nor
// does uploading as `type: authenticated` — both were measured against this account and
// both still 401. The download endpoint is a different door: it authenticates with the
// api key rather than being subject to the delivery ACL, and returns the file with its
// real content type.
//
// Rate-limited as part of the Admin API, so this is the fallback path only — assets we
// upload ourselves go to `raw`, which delivers normally.
export const signedDownloadUrl = ({ publicId, format, resourceType = 'image', type = 'upload' }) =>
  cloudinary.utils.private_download_url(publicId, format, { resource_type: resourceType, type });
