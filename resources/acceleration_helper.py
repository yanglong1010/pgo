import json
import os
import shlex
import subprocess
from functools import wraps
from flask import request

SUCCESS = "success"
REQUEST_ID_HEADER = 'x-fc-request-id'
REQUEST_ID_INITIALIZER = 'x-fc-function-initializer'
REQUEST_ID_HANDLER = 'x-fc-function-handler'
SRCTL = '/code/srctl'
OSSUTIL64 = "/code/ossutil64"
TMP_OSSUTIL64 = "/tmp/ossutil64"


def acceleration_interceptor(func):
   print('function {} definition'.format(func.__name__))

   @wraps(func)
   def wrapper(*args, **kwargs):
      print('before invoking function {}'.format(func.__name__))
      data = request.get_data(as_text=True).split(';')
      m = {}
      for part in data:
         arr = part.split('=')
         if len(arr) == 2:
            m[str(arr[0])] = arr[1]

      print(json.dumps(m))

      try:
         if 'type' in m:
            t = m['type']
            print('op type is {}'.format(t))
            if t == 'dump':
               result = dump()

               if 'file' in m and m['file']:
                  srpath = os.environ["SRPATH"]
                  result = do_save(srpath, m['file'])

               if 'bucket' in m:
                  result = upload_to_oss(m['accessKeyId'], m['accessKeySecret'], m['endpoint'], m['bucket'], m['file'])

               return result
      except Exception as e:
         msg = str(e)
         print(msg)
         return msg

      print('invoke original handler')
      return func()

   return wrapper


def do_save(srpath, archive_file_path):
   do_cmd(["tar", '-czf', archive_file_path, '.'],
          srpath,
          "create archive file {} success".format(archive_file_path),
          "create archive file {} error".format(archive_file_path))
   return SUCCESS


def upload_to_oss(access_key_id, access_key_secret, endpoint, bucket, file_path):
   file_name = file_path
   if "/" in file_path:
      file_name = file_path[file_path.rindex("/") + 1:]

   if not bucket.endswith("/"):
      bucket += "/"

   if not bucket.startswith("oss://"):
      bucket = "oss://" + bucket

   oss_file_path = bucket + file_name

   do_cmd(["cp", OSSUTIL64, TMP_OSSUTIL64], None, "cp ossutil64 success", "cp ossutil64 error")

   do_cmd(["chmod", "u+x", TMP_OSSUTIL64], None, "chmod u+x ossutil64 success", "chmod u+x ossutil64 error")

   do_cmd([TMP_OSSUTIL64, "mb", bucket, "-e", endpoint, "-i", access_key_id, "-k", access_key_secret],
          None,
          "create oss bucket [" + bucket + "] success",
          "create oss bucket [" + bucket + "] error")

   do_cmd([TMP_OSSUTIL64, "cp", file_path, oss_file_path, "-f", "-e", endpoint, "-i", access_key_id, "-k",
           access_key_secret],
          None,
          "upload file {} to oss [{}] success".format(file_path, oss_file_path),
          "upload file {} to oss [{}] error".format(file_path, oss_file_path))

   do_cmd([TMP_OSSUTIL64, "stat", oss_file_path, "-e", endpoint, "-i", access_key_id, "-k", access_key_secret],
          None,
          "stat oss file {} success".format(oss_file_path),
          "stat oss file {} error".format(oss_file_path))

   print('upload {} to oss file {} success'.format(file_path, oss_file_path))

   return SUCCESS


def dump():
   print('dumping...')
   del os.environ['PYCDSMODE']
   del os.environ['PYCDSLIST']
   cmd = shlex.split('{} dump'.format(SRCTL))
   return_code = do_cmd(cmd)
   if return_code != 0:
      err = "dump error: return code {}".format(return_code)
      print(err)
      raise Exception(err)
   else:
      print(SUCCESS)
      return SUCCESS


def do_cmd(cmd, cwd=None, success_msg=None, error_msg=None):
   p = subprocess.Popen(cmd, shell=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=cwd)
   print(p.communicate()[0])
   if p.returncode == 0:
      if success_msg is not None:
         print(success_msg)
      return p.returncode
   else:
      if error_msg is not None:
         print(error_msg)
      raise Exception('command [{}] return code is {}'.format(cmd, p.returncode))
