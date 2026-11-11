"use strict";

const fs = require("fs");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command
} = require("@aws-sdk/client-s3");

const CONTENT_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function normalizeObjectKey(value) {
  const key = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = key.split("/");
  if (!key || parts.some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid object storage key.");
  }
  return key;
}

function createObjectStorage({ env = process.env, client = null } = {}) {
  const accountId = String(env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = String(env.R2_BUCKET_NAME || "").trim();
  const endpoint = String(env.R2_ENDPOINT || (accountId ? "https://" + accountId + ".r2.cloudflarestorage.com" : "")).trim();
  const configured = Boolean(client || (accountId && accessKeyId && secretAccessKey && bucket && endpoint));
  const s3 = client || (configured ? new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }
  }) : null);

  async function putBuffer(key, buffer, contentType = "application/octet-stream") {
    if (!configured) return false;
    const safeKey = normalizeObjectKey(key);
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: safeKey,
      Body: body,
      ContentLength: body.length,
      ContentType: contentType
    }));
    return true;
  }

  async function putFile(key, filePath, contentType) {
    if (!configured) return false;
    const safeKey = normalizeObjectKey(key);
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error("Object storage upload source must be a regular file.");
    const type = contentType || CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: safeKey,
      Body: fs.createReadStream(filePath),
      ContentLength: stat.size,
      ContentType: type
    }));
    return true;
  }

  async function getObject(key) {
    if (!configured) return null;
    const safeKey = normalizeObjectKey(key);
    try {
      return await s3.send(new GetObjectCommand({ Bucket: bucket, Key: safeKey }));
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode || error?.statusCode;
      if (status === 404 || error?.name === "NoSuchKey" || error?.name === "NotFound") return null;
      throw error;
    }
  }

  async function getBuffer(key) {
    const result = await getObject(key);
    if (!result?.Body) return null;
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async function getJson(key) {
    const buffer = await getBuffer(key);
    if (!buffer) return null;
    return JSON.parse(buffer.toString("utf8"));
  }

  async function putJson(key, value) {
    return putBuffer(key, Buffer.from(JSON.stringify(value)), "application/json; charset=utf-8");
  }

  async function exists(key) {
    if (!configured) return false;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: normalizeObjectKey(key) }));
      return true;
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode || error?.statusCode;
      if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return false;
      throw error;
    }
  }

  async function deleteObject(key) {
    if (!configured) return false;
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: normalizeObjectKey(key) }));
    return true;
  }

  async function listKeys(prefix) {
    if (!configured) return [];
    const safePrefix = prefix ? normalizeObjectKey(prefix).replace(/\/$/, "") + "/" : "";
    const keys = [];
    let continuationToken;
    do {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: safePrefix,
        ContinuationToken: continuationToken
      }));
      for (const item of page.Contents || []) if (item.Key) keys.push(item.Key);
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  async function uploadDirectory(localDir, prefix) {
    if (!configured) return [];
    const root = path.resolve(localDir);
    const baseKey = normalizeObjectKey(prefix).replace(/\/$/, "");
    const uploaded = [];
    async function walk(directory) {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const key = normalizeObjectKey(baseKey + "/" + relative);
          await putFile(key, absolute);
          uploaded.push(key);
        }
      }
    }
    await walk(root);
    return uploaded;
  }

  return {
    configured,
    bucket,
    endpoint,
    putBuffer,
    putFile,
    putJson,
    getObject,
    getBuffer,
    getJson,
    exists,
    deleteObject,
    listKeys,
    uploadDirectory
  };
}

module.exports = { createObjectStorage, normalizeObjectKey, CONTENT_TYPES };
