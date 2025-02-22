'use strict';
const Cesium = require('cesium');
const mime = require('mime');
const addBuffer = require('./addBuffer');
const ForEach = require('./ForEach');
const getImageExtension = require('./getImageExtension');
const mergeBuffers = require('./mergeBuffers');
const removeUnusedElements = require('./removeUnusedElements');
const addExtensionsRequired = require('./addExtensionsRequired');

const gm = require('gm');
const { DWebp } = require('cwebp');

const defaultValue = Cesium.defaultValue;
const defined = Cesium.defined;
const WebGLConstants = Cesium.WebGLConstants;

const os = require('os');
const fs = require('fs');
const { exec } = require("child_process");
const uuidv4  = require('uuid').v4;

// .glsl shaders are text/plain type
mime.define({'text/plain': ['glsl']}, true);

// .basis is not a supported mime type, so add it
mime.define({'image/basis': ['basis']}, true);

// .ktx2 (KTX2) is not a supported mime type, so add it
mime.define({'image/ktx2': ['ktx2']}, true);

module.exports = writeResources;

/**
 * Write glTF resources as data uris, buffer views, or files.
 *
 * @param {Object} gltf A javascript object containing a glTF asset.
 * @param {Object} [options] Object with the following properties:
 * @param {String} [options.name] The name of the glTF asset, for writing separate resources.
 * @param {Boolean} [options.separateBuffers=false] Whether to save buffers as separate files.
 * @param {Boolean} [options.separateShaders=false] Whether to save shaders as separate files.
 * @param {Boolean} [options.separateTextures=false] Whether to save images as separate files.
 * @param {Boolean} [options.dataUris=false] Write embedded resources as data uris instead of buffer views.
 * @param {Boolean} [options.dracoOptions.uncompressedFallback=false] If set, add uncompressed fallback versions of the compressed meshes.
 * @param {Object} [options.bufferStorage] When defined, the glTF buffer's underlying Buffer object will be saved here instead of encoded as a data uri or saved as a separate resource.
 * @param {Object} [options.separateResources] When defined, buffers of separate resources will be saved here.
 * @returns {Object} The glTF asset.
 *
 * @private
 */
async function writeResources(gltf, options) {
    options = defaultValue(options, {});
    options.separateBuffers = defaultValue(options.separateBuffers, false);
    options.separateTextures = defaultValue(options.separateTextures, false);
    options.separateShaders = defaultValue(options.separateShaders, false);
    options.dataUris = defaultValue(options.dataUris, false);

    // Remember which of the resources have been written, so we can re-use them.
    const writtenResourceMap = {};

    await ForEach.imageAsync(gltf, async function(image, i) {
        await writeImage(gltf, image, i, writtenResourceMap, options);
    });

    ForEach.shader(gltf, function(shader, i) {
        writeShader(gltf, shader, i, writtenResourceMap, options);
    });

    // Buffers need to be written last because images and shaders may write to new buffers
    removeUnusedElements(gltf, ['accessor', 'bufferView', 'buffer']);
    mergeBuffers(gltf, options.name);

    ForEach.buffer(gltf, function(buffer, bufferId) {
        writeBuffer(gltf, buffer, bufferId, writtenResourceMap, options);
    });

    ForEach.texture(gltf, function(texture) {
      if (options.encodeBasis) {
        texture.extensions = {
          "KHR_texture_basisu" : {
            "source": texture.source
          }
        }
      }
    });

    return gltf;
}

function writeBuffer(gltf, buffer, i, writtenResourceMap, options) {
    if (defined(options.bufferStorage) && !options.separateBuffers) {
        writeBufferStorage(buffer, options);
    } else {
        writeResource(gltf, buffer, i, options.separateBuffers, true, '.bin', writtenResourceMap, options);
    }
}

function writeBufferStorage(buffer, options) {
    let combinedBuffer = options.bufferStorage.buffer;
    combinedBuffer = defined(combinedBuffer) ? combinedBuffer : Buffer.alloc(0);
    combinedBuffer = Buffer.concat([combinedBuffer, buffer.extras._pipeline.source]);
    options.bufferStorage.buffer = combinedBuffer;
}

function writeImage(gltf, image, i, writtenResourceMap, options) {
    const uid = uuidv4();
    return new Promise((resolve, reject) => {
      const extension = getImageExtension(image.extras._pipeline.source);
      if (extension == '.webp' && options.decodeWebP) {
          const decoder = new DWebp(image.extras._pipeline.source);
          decoder.write(`${os.tmpdir()}/image-${uid}.png`, function(err) {
            if (err) {
              reject(err)
            } else {
              resolve('.png')
            }
          })
      } else {
        fs.writeFile(`${os.tmpdir()}/image-${uid}${extension}`, image.extras._pipeline.source, (err) => {
          if (err) {
            console.log("Error", err)
            reject(err)
          } else {
            resolve(extension)
          }
        })
      }
    })
    .then((extension) => {
      if (options.encodeBasis && extension != 'ktx2') {
        return new Promise((resolve, reject) => {
          exec(`basisu -ktx2 -mipmap ${options.basisLinear ? '-linear' : ''} ${options.basisQuality ? `-q ${options.basisQuality}` : ''} ${os.tmpdir()}/image-${uid}${extension} -output_path ${os.tmpdir()}`, (error, stdout, stderr) => {
            if (error) {
              console.log("Error", error);
              reject(error);
            }
            fs.readFile(`${os.tmpdir()}/image-${uid}.ktx2`, (err, data) => {
              if (err) {
                console.log("Error", err);
                reject(err);
              }
              image.extras._pipeline.source = data
              fs.unlinkSync(`${os.tmpdir()}/image-${uid}${extension}`)
              resolve('.ktx2')
            });
          })
        })
      }
      else if (options.jpegCompressionRatio) {
        return new Promise((resolve, reject) => {
          gm(`${os.tmpdir()}/image-${uid}${extension}`)
          .quality(options.jpegCompressionRatio)
          .write(`${os.tmpdir()}/image-${uid}.jpg`, (err, buffer) => {
            if (err) {
              reject(err)
            } else {
              resolve('.jpg')
            }
          }) 
        })
      } else {
        return extension;
      }
    })
    .then((extension) => {
      return new Promise((resolve, reject) => {
        fs.readFile(`${os.tmpdir()}/image-${uid}${extension}`, (err, data) => {
          if (err) {
            console.log("Error", err);
            reject(err);
          }
          image.extras._pipeline.source = data
          fs.unlinkSync(`${os.tmpdir()}/image-${uid}${extension}`)
          resolve(image)
        });
      })
    })
    .then((image) => {
      const extension = getImageExtension(image.extras._pipeline.source);
      console.log("Final extension", extension)
      writeResource(gltf, image, i, options.separateTextures, options.dataUris, extension, writtenResourceMap, options);
      if (extension == '.ktx2') {
        addExtensionsRequired(gltf, 'KHR_texture_basisu');
      }
      if (defined(image.bufferView)) {
          // Preserve the image mime type when writing to a buffer view
          image.mimeType = mime.getType(extension);
      }
    })
}

function writeShader(gltf, shader, i, writtenResourceMap, options) {
    writeResource(gltf, shader, i, options.separateShaders, options.dataUris, '.glsl', writtenResourceMap, options);
}

function writeResource(gltf, object, index, separate, dataUris, extension, writtenResourceMap, options) {
    if (separate) {
        writeFile(gltf, object, index, extension, writtenResourceMap, options);
    } else if (dataUris) {
        writeDataUri(object, extension);
    } else {
        writeBufferView(gltf, object, writtenResourceMap);
    }
}

function writeDataUri(object, extension) {
    delete object.bufferView;
    const source = object.extras._pipeline.source;
    const mimeType = mime.getType(extension);
    object.uri = 'data:' + mimeType + ';base64,' + source.toString('base64');
}

function writeBufferView(gltf, object, writtenResourceMap) {
    delete object.uri;

    // If we've written this resource before, re-use the bufferView
    const resourceId = object.extras._pipeline.resourceId;
    if (defined(resourceId) && defined(writtenResourceMap[resourceId])) {
        object.bufferView = writtenResourceMap[resourceId];
        return;
    }

    let source = object.extras._pipeline.source;
    if (typeof source === 'string') {
        source = Buffer.from(source);
    }
    object.bufferView = addBuffer(gltf, source);

    // Save the bufferView so we can re-use it later
    if (defined(resourceId)) {
        writtenResourceMap[resourceId] = object.bufferView;
    }
}

function getProgram(gltf, shaderIndex) {
    return ForEach.program(gltf, function(program, index) {
        if (program.fragmentShader === shaderIndex || program.vertexShader === shaderIndex) {
            return {
                program: program,
                index: index
            };
        }
    });
}

function getName(gltf, object, index, extension, options) {
    const gltfName = options.name;
    const objectName = object.name;

    if (defined(objectName)) {
        return objectName;
    } else if (extension === '.bin') {
        if (defined(gltfName)) {
            return gltfName + index;
        }
        return 'buffer' + index;
    } else if (extension === '.glsl') {
        const programInfo = getProgram(gltf, index);
        const program = programInfo.program;
        const programIndex = programInfo.index;
        const programName = program.name;
        const shaderType = object.type === WebGLConstants.FRAGMENT_SHADER ? 'FS' : 'VS';
        if (defined(programName)) {
            return programName + shaderType;
        } else if (defined(gltfName)) {
            return gltfName + shaderType + programIndex;
        }
        return shaderType.toLowerCase() + programIndex;
    }

    // Otherwise is an image
    if (defined(gltfName)) {
        return gltfName + index;
    }
    return 'image' + index;
}

function getRelativePath(gltf, object, index, extension, options) {
    const pipelineExtras = object.extras._pipeline;
    let relativePath = pipelineExtras.relativePath;
    if (defined(relativePath)) {
        return relativePath.replace(/\\/g, '/');
    }

    const name = getName(gltf, object, index, extension, options);
    relativePath = name + extension;

    // Check if a file of the same name already exists, and if so, append a number
    let number = 1;
    while (defined(options.separateResources[relativePath])) {
        relativePath = name + '_' + number + extension;
        number++;
    }
    return relativePath;
}

function writeFile(gltf, object, index, extension, writtenResourceMap, options) {
    delete object.bufferView;

    // If we've written this resource before, re-use the uri
    const resourceId = object.extras._pipeline.resourceId;
    if (defined(resourceId) && defined(writtenResourceMap[resourceId])) {
        object.uri = writtenResourceMap[resourceId];
        return;
    }

    const source = object.extras._pipeline.source;
    const relativePath = getRelativePath(gltf, object, index, extension, options);
    object.uri = relativePath;
    if (defined(options.separateResources)) {
        options.separateResources[relativePath] = source;
    }

    // Save the uri so we can re-use it later
    if (defined(resourceId)) {
        writtenResourceMap[resourceId] = object.uri;
    }
}
