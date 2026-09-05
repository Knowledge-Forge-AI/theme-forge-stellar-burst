#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#elif defined(__linux__)
#define _GNU_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L

#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/mount.h>
#elif defined(__linux__)
#include <sys/vfs.h>
#include <sys/sysmacros.h>
#else
#error "The directory snapshot addon supports only Darwin and Linux."
#endif

#ifndef O_CLOEXEC
#error "O_CLOEXEC is required by the directory snapshot backend."
#endif
#ifndef O_NOFOLLOW
#error "O_NOFOLLOW is required by the directory snapshot backend."
#endif
#ifndef O_DIRECTORY
#error "O_DIRECTORY is required by the directory snapshot backend."
#endif
#ifndef F_DUPFD_CLOEXEC
#error "F_DUPFD_CLOEXEC is required by the directory snapshot backend."
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#error "AT_SYMLINK_NOFOLLOW is required by the directory snapshot backend."
#endif

#define BACKEND_ID "native-addon-posix-openat-v1"
#define BACKEND_ABI_VERSION 1
#define MAXIMUM_READ_BYTES (64U * 1024U * 1024U)

typedef enum {
  HANDLE_KIND_ROOT = 1,
  HANDLE_KIND_DIRECTORY = 2,
  HANDLE_KIND_REGULAR = 3
} handle_kind;

typedef struct {
  int fd;
  handle_kind kind;
  bool closed;
} native_handle;

static napi_value throw_fixed(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static bool napi_ok_or_throw(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  napi_throw_error(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot operation failed.");
  return false;
}

static napi_value undefined_value(napi_env env) {
  napi_value result;
  if (!napi_ok_or_throw(env, napi_get_undefined(env, &result))) return NULL;
  return result;
}

static const char *errno_family(int error_number) {
  switch (error_number) {
    case EMFILE:
    case ENFILE:
      return "RESOURCE_LIMIT_EXCEEDED";
    case ENOENT:
    case ESTALE:
      return "DIRECTORY_SOURCE_CHANGED";
    default:
      return "DIRECTORY_NATIVE_ERROR";
  }
}

static napi_value throw_errno_family(napi_env env, int error_number) {
  const char *code = errno_family(error_number);
  if (strcmp(code, "RESOURCE_LIMIT_EXCEEDED") == 0) {
    return throw_fixed(env, code, "Directory snapshot descriptor limit was exceeded.");
  }
  if (strcmp(code, "DIRECTORY_SOURCE_CHANGED") == 0) {
    return throw_fixed(env, code, "Directory source changed during authenticated access.");
  }
  return throw_fixed(env, code, "Native directory snapshot operation failed.");
}

static void finalize_handle(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  native_handle *handle = (native_handle *)data;
  if (handle == NULL) return;
  if (!handle->closed && handle->fd >= 0) {
    handle->closed = true;
    int fd = handle->fd;
    handle->fd = -1;
    (void)close(fd);
  }
  free(handle);
}

static const napi_type_tag HANDLE_TYPE_TAG = {
  0x7466736268616e64ULL, /* "tfsbhand" */
  0x6c65763130303031ULL  /* "lev10001" */
};

static napi_value create_handle(napi_env env, int fd, handle_kind kind) {
  native_handle *handle = (native_handle *)calloc(1, sizeof(*handle));
  if (handle == NULL) {
    (void)close(fd);
    return throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot allocation failed.");
  }
  handle->fd = fd;
  handle->kind = kind;
  handle->closed = false;
  napi_value external;
  if (!napi_ok_or_throw(env, napi_create_external(env, handle, finalize_handle, NULL, &external))) {
    finalize_handle(env, handle, NULL);
    return NULL;
  }
  if (!napi_ok_or_throw(env, napi_type_tag_object(env, external, &HANDLE_TYPE_TAG))) {
    return NULL;
  }
  return external;
}

static native_handle *get_handle(napi_env env, napi_value value, handle_kind required_kind) {
  bool matches = false;
  if (value == NULL ||
      napi_check_object_type_tag(env, value, &HANDLE_TYPE_TAG, &matches) != napi_ok ||
      !matches) {
    throw_fixed(env, "DIRECTORY_INVALID_HANDLE", "Native directory snapshot handle is invalid.");
    return NULL;
  }
  native_handle *handle = NULL;
  if (napi_get_value_external(env, value, (void **)&handle) != napi_ok || handle == NULL) {
    throw_fixed(env, "DIRECTORY_INVALID_HANDLE", "Native directory snapshot handle is invalid.");
    return NULL;
  }
  if (handle->closed || handle->fd < 0) {
    throw_fixed(env, "DIRECTORY_USE_AFTER_CLOSE", "Native directory snapshot handle is closed.");
    return NULL;
  }
  if (required_kind == HANDLE_KIND_DIRECTORY &&
      handle->kind != HANDLE_KIND_ROOT && handle->kind != HANDLE_KIND_DIRECTORY) {
    throw_fixed(env, "DIRECTORY_INVALID_HANDLE", "Native directory snapshot handle has the wrong kind.");
    return NULL;
  }
  if (required_kind == HANDLE_KIND_REGULAR && handle->kind != HANDLE_KIND_REGULAR) {
    throw_fixed(env, "DIRECTORY_INVALID_HANDLE", "Native directory snapshot handle has the wrong kind.");
    return NULL;
  }
  return handle;
}

static bool valid_utf8(const unsigned char *bytes, size_t length) {
  size_t index = 0;
  while (index < length) {
    unsigned char first = bytes[index++];
    if (first <= 0x7f) continue;
    size_t continuation = 0;
    uint32_t value = 0;
    uint32_t minimum = 0;
    if ((first & 0xe0U) == 0xc0U) {
      continuation = 1;
      value = first & 0x1fU;
      minimum = 0x80U;
    } else if ((first & 0xf0U) == 0xe0U) {
      continuation = 2;
      value = first & 0x0fU;
      minimum = 0x800U;
    } else if ((first & 0xf8U) == 0xf0U) {
      continuation = 3;
      value = first & 0x07U;
      minimum = 0x10000U;
    } else {
      return false;
    }
    if (index + continuation > length) return false;
    for (size_t offset = 0; offset < continuation; offset += 1) {
      unsigned char next = bytes[index++];
      if ((next & 0xc0U) != 0x80U) return false;
      value = (value << 6U) | (next & 0x3fU);
    }
    if (value < minimum || value > 0x10ffffU || (value >= 0xd800U && value <= 0xdfffU)) return false;
  }
  return true;
}

static bool validate_component_bytes(const char *component, size_t length) {
  if (length == 0 || length > NAME_MAX) return false;
  if ((length == 1 && component[0] == '.') ||
      (length == 2 && component[0] == '.' && component[1] == '.')) return false;
  for (size_t index = 0; index < length; index += 1) {
    unsigned char byte = (unsigned char)component[index];
    if (byte == 0 || byte < 0x20U || byte == 0x7fU || byte == '/' || byte == '\\') return false;
  }
  return valid_utf8((const unsigned char *)component, length);
}

static char *get_component(napi_env env, napi_value value) {
  napi_valuetype type;
  if (!napi_ok_or_throw(env, napi_typeof(env, value, &type))) return NULL;
  if (type != napi_string) {
    throw_fixed(env, "DIRECTORY_INVALID_COMPONENT", "Directory component is invalid.");
    return NULL;
  }
  size_t length = 0;
  if (!napi_ok_or_throw(env, napi_get_value_string_utf8(env, value, NULL, 0, &length))) return NULL;
  char *component = (char *)malloc(length + 1U);
  if (component == NULL) {
    throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot allocation failed.");
    return NULL;
  }
  size_t written = 0;
  if (!napi_ok_or_throw(env, napi_get_value_string_utf8(env, value, component, length + 1U, &written))) {
    free(component);
    return NULL;
  }
  if (written != length || !validate_component_bytes(component, length)) {
    free(component);
    throw_fixed(env, "DIRECTORY_INVALID_COMPONENT", "Directory component is invalid.");
    return NULL;
  }
  return component;
}

static napi_value open_filesystem_root(napi_env env, napi_callback_info info) {
  (void)info;
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return throw_errno_family(env, errno);
  return create_handle(env, fd, HANDLE_KIND_ROOT);
}

static napi_value open_child(napi_env env, napi_callback_info info, bool directory) {
  size_t argc = 2;
  napi_value argv[2];
  if (!napi_ok_or_throw(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))) return NULL;
  if (argc != 2) return throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot arguments are invalid.");
  native_handle *parent = get_handle(env, argv[0], HANDLE_KIND_DIRECTORY);
  if (parent == NULL) return NULL;
  char *component = get_component(env, argv[1]);
  if (component == NULL) return NULL;

  struct stat before;
  if (fstatat(parent->fd, component, &before, AT_SYMLINK_NOFOLLOW) != 0) {
    int saved = errno;
    free(component);
    return throw_errno_family(env, saved);
  }
  if (S_ISLNK(before.st_mode)) {
    free(component);
    return throw_fixed(env, directory ? "DIRECTORY_ANCESTRY_SYMLINK" : "DIRECTORY_TRAVERSED_SYMLINK",
                       "Directory snapshot traversal encountered a symlink.");
  }

  int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
  if (directory) flags |= O_DIRECTORY;
  int fd = openat(parent->fd, component, flags);
  int saved = errno;
  free(component);
  if (fd < 0) {
    if (saved == ELOOP || (directory && saved == ENOTDIR)) {
      return throw_fixed(env, directory ? "DIRECTORY_ANCESTRY_SYMLINK" : "DIRECTORY_TRAVERSED_SYMLINK",
                         "Directory snapshot traversal encountered a symlink or invalid type.");
    }
    return throw_errno_family(env, saved);
  }
  struct stat opened;
  if (fstat(fd, &opened) != 0) {
    saved = errno;
    (void)close(fd);
    return throw_errno_family(env, saved);
  }
  if ((directory && !S_ISDIR(opened.st_mode)) || (!directory && !S_ISREG(opened.st_mode))) {
    (void)close(fd);
    return throw_fixed(env, directory ? "DIRECTORY_NOT_DIRECTORY" : "DIRECTORY_SPECIAL_FILE",
                       "Directory snapshot child has an invalid type.");
  }
  if (before.st_dev != opened.st_dev || before.st_ino != opened.st_ino ||
      ((before.st_mode & S_IFMT) != (opened.st_mode & S_IFMT))) {
    (void)close(fd);
    return throw_fixed(env, "DIRECTORY_SOURCE_CHANGED", "Directory source changed during authenticated child open.");
  }
  return create_handle(env, fd, directory ? HANDLE_KIND_DIRECTORY : HANDLE_KIND_REGULAR);
}

static napi_value open_child_directory(napi_env env, napi_callback_info info) {
  return open_child(env, info, true);
}

static napi_value open_child_regular(napi_env env, napi_callback_info info) {
  return open_child(env, info, false);
}

static const char *stat_kind(mode_t mode) {
  if (S_ISDIR(mode)) return "directory";
  if (S_ISREG(mode)) return "file";
  if (S_ISLNK(mode)) return "symlink";
  return "special";
}

static bool set_string(napi_env env, napi_value object, const char *name, const char *value) {
  napi_value child;
  return napi_ok_or_throw(env, napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &child)) &&
         napi_ok_or_throw(env, napi_set_named_property(env, object, name, child));
}

static bool set_uint32(napi_env env, napi_value object, const char *name, uint32_t value) {
  napi_value child;
  return napi_ok_or_throw(env, napi_create_uint32(env, value, &child)) &&
         napi_ok_or_throw(env, napi_set_named_property(env, object, name, child));
}

static bool set_bigint_uint64(napi_env env, napi_value object, const char *name, uint64_t value) {
  napi_value child;
  return napi_ok_or_throw(env, napi_create_bigint_uint64(env, value, &child)) &&
         napi_ok_or_throw(env, napi_set_named_property(env, object, name, child));
}

static bool set_bigint_int64(napi_env env, napi_value object, const char *name, int64_t value) {
  napi_value child;
  return napi_ok_or_throw(env, napi_create_bigint_int64(env, value, &child)) &&
         napi_ok_or_throw(env, napi_set_named_property(env, object, name, child));
}

static napi_value stat_to_value(napi_env env, const struct stat *value) {
  napi_value result;
  if (!napi_ok_or_throw(env, napi_create_object(env, &result))) return NULL;
  if (!set_string(env, result, "type", stat_kind(value->st_mode)) ||
      !set_bigint_uint64(env, result, "device", (uint64_t)value->st_dev) ||
      !set_bigint_uint64(env, result, "inode", (uint64_t)value->st_ino) ||
      !set_uint32(env, result, "mode", (uint32_t)value->st_mode) ||
      !set_bigint_uint64(env, result, "linkCount", (uint64_t)value->st_nlink) ||
      !set_bigint_uint64(env, result, "size", (uint64_t)value->st_size)) return NULL;
#if defined(__APPLE__)
  if (!set_bigint_int64(env, result, "mtimeSeconds", (int64_t)value->st_mtimespec.tv_sec) ||
      !set_uint32(env, result, "mtimeNanoseconds", (uint32_t)value->st_mtimespec.tv_nsec) ||
      !set_bigint_int64(env, result, "ctimeSeconds", (int64_t)value->st_ctimespec.tv_sec) ||
      !set_uint32(env, result, "ctimeNanoseconds", (uint32_t)value->st_ctimespec.tv_nsec) ||
      !set_bigint_uint64(env, result, "generation", (uint64_t)value->st_gen)) return NULL;
#else
  if (!set_bigint_int64(env, result, "mtimeSeconds", (int64_t)value->st_mtim.tv_sec) ||
      !set_uint32(env, result, "mtimeNanoseconds", (uint32_t)value->st_mtim.tv_nsec) ||
      !set_bigint_int64(env, result, "ctimeSeconds", (int64_t)value->st_ctim.tv_sec) ||
      !set_uint32(env, result, "ctimeNanoseconds", (uint32_t)value->st_ctim.tv_nsec)) return NULL;
#endif
  return result;
}

static napi_value stat_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (!napi_ok_or_throw(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))) return NULL;
  if (argc != 1) return throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot arguments are invalid.");
  native_handle *handle = get_handle(env, argv[0], (handle_kind)0);
  if (handle == NULL) return NULL;
  struct stat value;
  if (fstat(handle->fd, &value) != 0) return throw_errno_family(env, errno);
  return stat_to_value(env, &value);
}

#if defined(__linux__)
static bool is_exact_ext4_mount(int fd) {
  struct statfs fs_stat;
  if (fstatfs(fd, &fs_stat) != 0 || (unsigned long)fs_stat.f_type != 0xEF53UL) {
    return false;
  }

  struct stat st;
  if (fstat(fd, &st) != 0) {
    return false;
  }
  unsigned int target_major = major(st.st_dev);
  unsigned int target_minor = minor(st.st_dev);

  bool have_mnt_id = false;
  uint64_t target_mnt_id = 0;

#if defined(STATX_MNT_ID) && defined(AT_EMPTY_PATH) && defined(AT_STATX_SYNC_AS_STAT)
  struct statx stx;
  memset(&stx, 0, sizeof(stx));
  if (statx(fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT, STATX_MNT_ID, &stx) == 0) {
    if ((stx.stx_mask & STATX_MNT_ID) != 0) {
      have_mnt_id = true;
      target_mnt_id = stx.stx_mnt_id;
    }
  }
#endif

  int proc_fd = open("/proc/self/mountinfo", O_RDONLY | O_CLOEXEC);
  if (proc_fd < 0) {
    return false;
  }

  size_t capacity = 16384;
  size_t length = 0;
  char *buffer = (char *)malloc(capacity + 1);
  if (buffer == NULL) {
    (void)close(proc_fd);
    return false;
  }

  while (1) {
    if (length == capacity) {
      if (capacity >= 2 * 1024 * 1024) {
        free(buffer);
        (void)close(proc_fd);
        return false;
      }
      size_t new_capacity = capacity * 2;
      char *new_buffer = (char *)realloc(buffer, new_capacity + 1);
      if (new_buffer == NULL) {
        free(buffer);
        (void)close(proc_fd);
        return false;
      }
      buffer = new_buffer;
      capacity = new_capacity;
    }
    ssize_t bytes_read = read(proc_fd, buffer + length, capacity - length);
    if (bytes_read < 0) {
      if (errno == EINTR) continue;
      free(buffer);
      (void)close(proc_fd);
      return false;
    }
    if (bytes_read == 0) break;
    length += (size_t)bytes_read;
  }
  (void)close(proc_fd);
  buffer[length] = '\0';

  bool found_match = false;
  bool match_is_ext4 = false;
  size_t matched_dev_count = 0;
  size_t non_ext4_matched_dev_count = 0;

  size_t offset = 0;
  while (offset < length) {
    size_t line_end = offset;
    while (line_end < length && buffer[line_end] != '\n') {
      line_end++;
    }
    buffer[line_end] = '\0';
    char *cursor = buffer + offset;

    char *endptr = NULL;
    unsigned long long line_mnt_id = strtoull(cursor, &endptr, 10);
    if (endptr != cursor && *endptr == ' ') {
      cursor = endptr + 1;
      (void)strtoull(cursor, &endptr, 10);
      if (endptr != cursor && *endptr == ' ') {
        cursor = endptr + 1;
        unsigned long dev_maj = strtoul(cursor, &endptr, 10);
        if (endptr != cursor && *endptr == ':') {
          cursor = endptr + 1;
          unsigned long dev_min = strtoul(cursor, &endptr, 10);
          if (endptr != cursor && *endptr == ' ') {
            cursor = endptr + 1;
            while (*cursor != '\0' && *cursor != ' ') cursor++;
            if (*cursor == ' ') {
              cursor++;
              while (*cursor != '\0' && *cursor != ' ') cursor++;
              if (*cursor == ' ') {
                cursor++;
                while (*cursor != '\0' && *cursor != ' ') cursor++;
                if (*cursor == ' ') {
                  cursor++;
                  bool found_dash = false;
                  while (*cursor != '\0') {
                    if (cursor[0] == '-' && (cursor[1] == ' ' || cursor[1] == '\t')) {
                      cursor += 2;
                      while (*cursor == ' ' || *cursor == '\t') cursor++;
                      found_dash = true;
                      break;
                    }
                    while (*cursor != '\0' && *cursor != ' ') cursor++;
                    if (*cursor == ' ') cursor++;
                  }
                  if (found_dash && *cursor != '\0') {
                    char fstype[64];
                    size_t f_len = 0;
                    while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t' && f_len + 1 < sizeof(fstype)) {
                      fstype[f_len++] = *cursor++;
                    }
                    fstype[f_len] = '\0';

                    if (have_mnt_id) {
                      if (line_mnt_id == target_mnt_id) {
                        found_match = true;
                        match_is_ext4 = (strcmp(fstype, "ext4") == 0);
                        break;
                      }
                    } else {
                      if (dev_maj == target_major && dev_min == target_minor) {
                        matched_dev_count++;
                        if (strcmp(fstype, "ext4") != 0) {
                          non_ext4_matched_dev_count++;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    offset = line_end + 1;
  }

  free(buffer);

  if (have_mnt_id) {
    return found_match && match_is_ext4;
  }
  return (matched_dev_count > 0 && non_ext4_matched_dev_count == 0);
}
#endif

static napi_value stat_filesystem(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (!napi_ok_or_throw(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))) return NULL;
  if (argc != 1) return throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot arguments are invalid.");
  native_handle *handle = get_handle(env, argv[0], (handle_kind)0);
  if (handle == NULL) return NULL;
  napi_value result;
  if (!napi_ok_or_throw(env, napi_create_object(env, &result))) return NULL;
  const char *filesystem_class = "unsupported";
#if defined(__APPLE__)
  struct statfs value;
  if (fstatfs(handle->fd, &value) != 0) return throw_errno_family(env, errno);
  if ((value.f_flags & MNT_LOCAL) != 0 && strcmp(value.f_fstypename, "apfs") == 0) filesystem_class = "apfs";
#else
  if (is_exact_ext4_mount(handle->fd)) filesystem_class = "ext4";
#endif
  if (!set_string(env, result, "class", filesystem_class) ||
      !set_string(env, result, "category", strcmp(filesystem_class, "unsupported") == 0 ? "unsupported" : "qualified-local")) return NULL;
  return result;
}

static napi_value read_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (!napi_ok_or_throw(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))) return NULL;
  if (argc != 1) return throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot arguments are invalid.");
  native_handle *handle = get_handle(env, argv[0], HANDLE_KIND_DIRECTORY);
  if (handle == NULL) return NULL;
  int duplicate = fcntl(handle->fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return throw_errno_family(env, errno);
  DIR *stream = fdopendir(duplicate);
  if (stream == NULL) {
    int saved = errno;
    (void)close(duplicate);
    return throw_errno_family(env, saved);
  }
  /* F_DUPFD_CLOEXEC shares the open-file-description offset. Always reset the
     new stream before reading so a prior enumeration cannot leave it at EOF. */
  rewinddir(stream);
  napi_value result;
  if (!napi_ok_or_throw(env, napi_create_array(env, &result))) {
    (void)closedir(stream);
    return NULL;
  }
  uint32_t output_index = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    size_t length = strlen(entry->d_name);
    if (!validate_component_bytes(entry->d_name, length)) {
      (void)closedir(stream);
      return throw_fixed(env, "DIRECTORY_INVALID_COMPONENT", "Directory entry name is invalid.");
    }
    struct stat child_stat;
    if (fstatat(handle->fd, entry->d_name, &child_stat, AT_SYMLINK_NOFOLLOW) != 0) {
      int saved = errno;
      (void)closedir(stream);
      return throw_errno_family(env, saved);
    }
    napi_value child;
    napi_value child_stat_value;
    if (!napi_ok_or_throw(env, napi_create_object(env, &child)) ||
        !set_string(env, child, "name", entry->d_name) ||
        !set_string(env, child, "kind", stat_kind(child_stat.st_mode)) ||
        (child_stat_value = stat_to_value(env, &child_stat)) == NULL ||
        !napi_ok_or_throw(env, napi_set_named_property(env, child, "stat", child_stat_value)) ||
        !napi_ok_or_throw(env, napi_set_element(env, result, output_index++, child))) {
      (void)closedir(stream);
      return NULL;
    }
    errno = 0;
  }
  int read_error = errno;
  if (closedir(stream) != 0 && read_error == 0) read_error = errno;
  if (read_error != 0) return throw_errno_family(env, read_error);
  return result;
}

static napi_value read_regular(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (!napi_ok_or_throw(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))) return NULL;
  if (argc != 2) return throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot arguments are invalid.");
  native_handle *handle = get_handle(env, argv[0], HANDLE_KIND_REGULAR);
  if (handle == NULL) return NULL;
  uint32_t maximum_bytes = 0;
  if (napi_get_value_uint32(env, argv[1], &maximum_bytes) != napi_ok || maximum_bytes > MAXIMUM_READ_BYTES) {
    return throw_fixed(env, "RESOURCE_LIMIT_EXCEEDED", "Directory snapshot read limit is invalid.");
  }
  if (lseek(handle->fd, 0, SEEK_SET) < 0) return throw_errno_family(env, errno);
  size_t allocation = (size_t)maximum_bytes + 1U;
  unsigned char *bytes = (unsigned char *)malloc(allocation == 0 ? 1U : allocation);
  if (bytes == NULL) return throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot allocation failed.");
  size_t total = 0;
  while (total < allocation) {
    ssize_t count = read(handle->fd, bytes + total, allocation - total);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) {
      int saved = errno;
      free(bytes);
      return throw_errno_family(env, saved);
    }
    if (count == 0) break;
    total += (size_t)count;
  }
  if (total > maximum_bytes) {
    free(bytes);
    return throw_fixed(env, "RESOURCE_LIMIT_EXCEEDED", "Selected directory file exceeds the read limit.");
  }
  napi_value result;
  napi_status status = napi_create_buffer_copy(env, total, bytes, NULL, &result);
  free(bytes);
  if (!napi_ok_or_throw(env, status)) return NULL;
  return result;
}

static napi_value close_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (!napi_ok_or_throw(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))) return NULL;
  if (argc != 1) return throw_fixed(env, "DIRECTORY_NATIVE_ERROR", "Native directory snapshot arguments are invalid.");
  native_handle *handle = NULL;
  if (napi_get_value_external(env, argv[0], (void **)&handle) != napi_ok || handle == NULL) {
    return throw_fixed(env, "DIRECTORY_INVALID_HANDLE", "Native directory snapshot handle is invalid.");
  }
  if (handle->closed || handle->fd < 0) return undefined_value(env);
  handle->closed = true;
  int fd = handle->fd;
  handle->fd = -1;
  if (close(fd) != 0) return throw_errno_family(env, errno);
  return undefined_value(env);
}

NAPI_MODULE_INIT() {
  napi_property_descriptor primitives[] = {
    { "openFilesystemRoot", NULL, open_filesystem_root, NULL, NULL, NULL, napi_enumerable, NULL },
    { "openChildDirectory", NULL, open_child_directory, NULL, NULL, NULL, napi_enumerable, NULL },
    { "openChildRegular", NULL, open_child_regular, NULL, NULL, NULL, napi_enumerable, NULL },
    { "readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_enumerable, NULL },
    { "statHandle", NULL, stat_handle, NULL, NULL, NULL, napi_enumerable, NULL },
    { "statFilesystem", NULL, stat_filesystem, NULL, NULL, NULL, napi_enumerable, NULL },
    { "readRegular", NULL, read_regular, NULL, NULL, NULL, napi_enumerable, NULL },
    { "closeHandle", NULL, close_handle, NULL, NULL, NULL, napi_enumerable, NULL },
  };
  napi_value backend;
  napi_value abi_version;
  if (!napi_ok_or_throw(env, napi_create_string_utf8(env, BACKEND_ID, NAPI_AUTO_LENGTH, &backend)) ||
      !napi_ok_or_throw(env, napi_create_uint32(env, BACKEND_ABI_VERSION, &abi_version))) return NULL;
  napi_property_descriptor facts[] = {
    { "backend", NULL, NULL, NULL, NULL, backend, napi_enumerable, NULL },
    { "abiVersion", NULL, NULL, NULL, NULL, abi_version, napi_enumerable, NULL },
  };
  if (!napi_ok_or_throw(env, napi_define_properties(env, exports, sizeof(primitives) / sizeof(primitives[0]), primitives)) ||
      !napi_ok_or_throw(env, napi_define_properties(env, exports, sizeof(facts) / sizeof(facts[0]), facts))) return NULL;
  return exports;
}
