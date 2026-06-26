import os

class Base:
    def run(self):
        return helper()

def helper():
    return os.getpid()
