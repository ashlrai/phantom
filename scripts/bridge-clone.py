"""Private Mac worker. clonefile never falls back to copying file contents."""
import ctypes
import os
import stat
import sys


def main():
    if len(sys.argv) != 3 or sys.platform != "darwin":
        return 2
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    clonefile = library.clonefile
    clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
    clonefile.restype = ctypes.c_int
    # Do not clone the directory in one syscall: a large tree can remain in
    # the kernel past the parent's deadline. Leaf calls make cancellation
    # responsive even when the volume is busy. Never copy file bytes.
    def clone_tree(source, destination):
        os.mkdir(destination, 0o700)
        with os.scandir(source) as entries:
            for entry in entries:
                target = os.path.join(destination, entry.name)
                if entry.is_dir(follow_symlinks=False):
                    clone_tree(entry.path, target)
                elif entry.is_file(follow_symlinks=False) or entry.is_symlink():
                    # CLONE_NOFOLLOW retains relative .bin/workspace links.
                    if clonefile(os.fsencode(entry.path), os.fsencode(target), 1) != 0:
                        raise OSError(ctypes.get_errno(), "clonefile failed")
                else:
                    raise OSError("Unsupported dependency file type")
        os.chmod(destination, stat.S_IMODE(os.stat(source, follow_symlinks=False).st_mode))

    clone_tree(sys.argv[1], sys.argv[2])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, AttributeError):
        # No dependency contents or arbitrary OS error messages in bridge logs.
        sys.exit(1)
