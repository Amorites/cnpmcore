import {
  AccessLevel,
  ContextProto,
  Inject,
} from '@eggjs/tegg';
import { setTimeout } from 'timers/promises';
import { rm } from 'fs/promises';
import { NFSAdapter } from '../../common/adapter/NFSAdapter';
import { NPMRegistry } from '../../common/adapter/NPMRegistry';
import { getScopeAndName } from '../../common/PackageUtil';
import { TaskState, TaskType } from '../../common/enum/Task';
import { TaskRepository } from '../../repository/TaskRepository';
import { PackageRepository } from '../../repository/PackageRepository';
import { UserRepository } from '../../repository/UserRepository';
import { Task, SyncPackageTaskOptions } from '../entity/Task';
import { AbstractService } from './AbstractService';
import { UserService } from './UserService';
import { PackageManagerService } from './PackageManagerService';
import { User } from '../entity/User';

function isoNow() {
  return new Date().toISOString();
}

@ContextProto({
  accessLevel: AccessLevel.PUBLIC,
})
export class PackageSyncerService extends AbstractService {
  @Inject()
  private readonly taskRepository: TaskRepository;
  @Inject()
  private readonly packageRepository: PackageRepository;
  @Inject()
  private readonly userRepository: UserRepository;
  @Inject()
  private readonly nfsAdapter: NFSAdapter;
  @Inject()
  private readonly npmRegistry: NPMRegistry;
  @Inject()
  private readonly userService: UserService;
  @Inject()
  private readonly packageManagerService: PackageManagerService;

  public async createTask(fullname: string, options?: SyncPackageTaskOptions) {
    let existsTask = await this.taskRepository.findTaskByTargetName(fullname, TaskType.SyncPackage, TaskState.Waiting);
    if (existsTask) return existsTask;
    // find processing task and update less than 1 min
    existsTask = await this.taskRepository.findTaskByTargetName(fullname, TaskType.SyncPackage, TaskState.Processing);
    if (existsTask && (Date.now() - existsTask.updatedAt.getTime() < 60000)) {
      return existsTask;
    }
    const task = Task.createSyncPackage(fullname, options);
    await this.taskRepository.saveTask(task);
    return task;
  }

  public async findTask(taskId: string) {
    const task = await this.taskRepository.findTask(taskId);
    return task;
  }

  public async findTaskLog(task: Task) {
    return await this.nfsAdapter.getDownloadUrlOrStream(task.logPath);
  }

  public async findExecuteTask() {
    const task = await this.taskRepository.executeWaitingTask(TaskType.SyncPackage);
    if (task && task.attempts > 3) {
      task.state = TaskState.Timeout;
      task.attempts -= 1;
      await this.taskRepository.saveTaskToHistory(task);
      return null;
    }
    return task;
  }

  private async syncUpstream(task: Task) {
    const registry = this.npmRegistry.registry;
    const fullname = task.targetName;
    let logs: string[] = [];
    let logId = '';
    logs.push(`[${isoNow()}][UP] 🚧🚧🚧🚧🚧 Waiting sync "${fullname}" task on ${registry} 🚧🚧🚧🚧🚧`);
    const failEnd = `❌❌❌❌❌ Sync ${registry}/${fullname} 🚮 give up 🚮 ❌❌❌❌❌`;
    try {
      const { data, status, res } = await this.npmRegistry.createSyncTask(fullname);
      logs.push(`[${isoNow()}][UP] 🚧 HTTP [${status}] timing: ${JSON.stringify(res.timing)}, data: ${JSON.stringify(data)}`);
      logId = data.logId;
    } catch (err: any) {
      const status = err.status || 'unknow';
      logs.push(`[${isoNow()}][UP] ❌ Sync ${fullname} fail, create sync task error: ${err}, status: ${status}`);
      logs.push(`[${isoNow()}][UP] ${failEnd}`);
      await this.appendTaskLog(task, logs.join('\n'));
      return;
    }
    if (!logId) {
      logs.push(`[${isoNow()}][UP] ❌ Sync ${fullname} fail, missing logId`);
      logs.push(`[${isoNow()}][UP] ${failEnd}`);
      await this.appendTaskLog(task, logs.join('\n'));
      return;
    }
    const startTime = Date.now();
    const maxTimeout = this.config.cnpmcore.sourceRegistrySyncTimeout;
    let logUrl = '';
    let offset = 0;
    let useTime = Date.now() - startTime;
    while (useTime < maxTimeout) {
      // sleep 1s ~ 6s in random
      await setTimeout(1000 + Math.random() * 5000);
      try {
        const { data, status, url } = await this.npmRegistry.getSyncTask(fullname, logId, offset);
        useTime = Date.now() - startTime;
        if (!logUrl) {
          logUrl = url;
        }
        const log = data && data.log || '';
        offset += log.length;
        if (data && data.syncDone) {
          logs.push(`[${isoNow()}][UP] 🟢 Sync ${fullname} success [${useTime}ms], log: ${logUrl}, offset: ${offset}`);
          logs.push(`[${isoNow()}][UP] 🟢🟢🟢🟢🟢 ${registry}/${fullname} 🟢🟢🟢🟢🟢`);
          await this.appendTaskLog(task, logs.join('\n'));
          return;
        }
        logs.push(`[${isoNow()}][UP] 🚧 HTTP [${status}] [${useTime}ms], offset: ${offset}`);
        await this.appendTaskLog(task, logs.join('\n'));
        logs = [];
      } catch (err: any) {
        useTime = Date.now() - startTime;
        const status = err.status || 'unknow';
        logs.push(`[${isoNow()}][UP] 🚧 HTTP [${status}] [${useTime}ms] error: ${err}`);
      }
    }
    // timeout
    logs.push(`[${isoNow()}][UP] ❌ Sync ${fullname} fail, timeout, log: ${logUrl}, offset: ${offset}`);
    logs.push(`[${isoNow()}][UP] ${failEnd}`);
    await this.appendTaskLog(task, logs.join('\n'));
  }

  public async executeTask(task: Task) {
    const fullname = task.targetName;
    const { tips, skipDependencies } = task.data as SyncPackageTaskOptions;
    const registry = this.npmRegistry.registry;
    if (this.config.cnpmcore.sourceRegistryIsCNpm) {
      // create sync task on sourceRegistry and skipDependencies = true
      await this.syncUpstream(task);
    }
    let logs: string[] = [];
    if (tips) {
      logs.push(`[${isoNow()}] 👉👉👉👉👉 Tips: ${tips} 👈👈👈👈👈`);
    }
    logs.push(`[${isoNow()}] 🚧🚧🚧🚧🚧 Start sync "${fullname}" from ${registry}, skipDependencies: ${!!skipDependencies} 🚧🚧🚧🚧🚧`);
    const logUrl = `${this.config.cnpmcore.registry}/-/package/${fullname}/syncs/${task.taskId}/log`;
    let result: any;
    try {
      result = await this.npmRegistry.getFullManifests(fullname);
    } catch (err: any) {
      const status = err.status || 'unknow';
      logs.push(`[${isoNow()}] ❌ Synced ${fullname} fail, request manifests error: ${err}, status: ${status}, log: ${logUrl}`);
      logs.push(`[${isoNow()}] ❌❌❌❌❌ ${fullname} ❌❌❌❌❌`);
      await this.finishTask(task, TaskState.Fail, logs.join('\n'));
      this.logger.info('[PackageSyncerService.executeTask:fail] taskId: %s, targetName: %s, request manifests error: %s, status: $%s', task.taskId, task.targetName, err, status);
      return;
    }
    const { url, data, headers, res, status } = result;
    let readme = data.readme || '';
    if (typeof readme !== 'string') {
      readme = JSON.stringify(readme);
    }
    // "time": {
    //   "created": "2021-03-27T12:30:23.891Z",
    //   "0.0.2": "2021-03-27T12:30:24.349Z",
    //   "modified": "2021-12-08T14:59:57.264Z",
    const timeMap = data.time || {};
    const failEnd = `❌❌❌❌❌ ${url || fullname} ❌❌❌❌❌`;
    logs.push(`[${isoNow()}] HTTP [${status}] content-length: ${headers['content-length']}, timing: ${JSON.stringify(res.timing)}`);

    // 1. save maintainers
    // maintainers: [
    //   { name: 'bomsy', email: 'b4bomsy@gmail.com' },
    //   { name: 'jasonlaster11', email: 'jason.laster.11@gmail.com' }
    // ],
    const maintainers = data.maintainers;
    const maintainersMap = {};
    const users: User[] = [];
    let changedUserCount = 0;
    if (Array.isArray(maintainers) && maintainers.length > 0) {
      logs.push(`[${isoNow()}] 🚧 Syncing maintainers: ${JSON.stringify(maintainers)}`);
      for (const maintainer of maintainers) {
        if (maintainer.name && maintainer.email) {
          maintainersMap[maintainer.name] = maintainer;
          const { changed, user } = await this.userService.savePublicUser(maintainer.name, maintainer.email);
          users.push(user);
          if (changed) {
            changedUserCount++;
            logs.push(`[${isoNow()}] 🟢 [${changedUserCount}] Synced ${maintainer.name} => ${user.name}(${user.userId})`);
          }
        }
      }
    }

    if (users.length === 0) {
      // invalid maintainers, sync fail
      logs.push(`[${isoNow()}] ❌ Invalid maintainers: ${JSON.stringify(maintainers)}, log: ${logUrl}`);
      logs.push(`[${isoNow()}] ${failEnd}`);
      await this.finishTask(task, TaskState.Fail, logs.join('\n'));
      this.logger.info('[PackageSyncerService.executeTask:fail] taskId: %s, targetName: %s, invalid maintainers',
        task.taskId, task.targetName);
      return;
    }

    const dependenciesSet = new Set<string>();

    const [ scope, name ] = getScopeAndName(fullname);
    let pkg = await this.packageRepository.findPackage(scope, name);
    const { data: existsData } = await this.packageManagerService.listPackageFullManifests(scope, name);
    const existsVersionMap = existsData && existsData.versions || {};
    const existsVersionCount = Object.keys(existsVersionMap).length;
    // 2. save versions
    const versions = Object.values<any>(data.versions || {});
    logs.push(`[${isoNow()}] 🚧 Syncing versions ${existsVersionCount} => ${versions.length}`);
    let syncVersionCount = 0;
    const differentMetas: any[] = [];
    for (const [ index, item ] of versions.entries()) {
      const version: string = item.version;
      if (!version) continue;
      let existsItem = existsVersionMap[version];
      if (!existsItem && pkg) {
        // try to read from db detect if last sync interrupt before refreshPackageManifestsToDists() be called
        existsItem = await this.packageManagerService.findPackageVersionManifest(pkg.packageId, version);
      }
      if (existsItem) {
        // check metaDataKeys, if different value, override exists one
        // https://github.com/cnpm/cnpmjs.org/issues/1667
        const metaDataKeys = [ 'peerDependenciesMeta', 'os', 'cpu', 'workspaces', 'hasInstallScript', 'deprecated' ];
        let diffMeta;
        for (const key of metaDataKeys) {
          if (JSON.stringify(item[key]) !== JSON.stringify(existsItem[key])) {
            if (!diffMeta) diffMeta = {};
            diffMeta[key] = item[key];
          }
        }
        if (diffMeta) {
          differentMetas.push([ existsItem, diffMeta ]);
        }
        continue;
      }
      const description: string = item.description;
      // "dist": {
      //   "shasum": "943e0ec03df00ebeb6273a5b94b916ba54b47581",
      //   "tarball": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz"
      // },
      const dist = item.dist;
      const tarball: string = dist && dist.tarball;
      if (!tarball) {
        logs.push(`[${isoNow()}] ❌ [${index}] Synced version ${version} fail, missing tarball, dist: ${JSON.stringify(dist)}`);
        await this.appendTaskLog(task, logs.join('\n'));
        logs = [];
        continue;
      }
      const publishTimeISO = timeMap[version];
      const publishTime = publishTimeISO ? new Date(publishTimeISO) : new Date();
      const delay = Date.now() - publishTime.getTime();
      logs.push(`[${isoNow()}] 🚧 [${index}] Syncing version ${version}, delay: ${delay}ms [${publishTimeISO}], tarball: ${tarball}`);
      let localFile: string;
      try {
        const { tmpfile, status, headers, res } = await this.npmRegistry.downloadTarball(tarball);
        localFile = tmpfile;
        logs.push(`[${isoNow()}] 🚧 [${index}] HTTP [${status}] content-length: ${headers['content-length']}, timing: ${JSON.stringify(res.timing)} => ${localFile}`);
        if (status !== 200) {
          if (localFile) {
            await rm(localFile, { force: true });
          }
          logs.push(`[${isoNow()}] ❌ [${index}] Synced version ${version} fail, download tarball status error: ${status}`);
          await this.appendTaskLog(task, logs.join('\n'));
          logs = [];
          continue;
        }
      } catch (err: any) {
        const status = err.status || 'unknow';
        logs.push(`[${isoNow()}] ❌ [${index}] Synced version ${version} fail, download tarball error: ${err}, status: ${status}`);
        await this.appendTaskLog(task, logs.join('\n'));
        logs = [];
        continue;
      }
      if (!pkg) {
        pkg = await this.packageRepository.findPackage(scope, name);
      }
      if (pkg) {
        // check again, make sure prefix version not exists
        const existsPkgVersion = await this.packageRepository.findPackageVersion(pkg.packageId, version);
        if (existsPkgVersion) {
          await rm(localFile, { force: true });
          logs.push(`[${isoNow()}] 🐛 [${index}] Synced version ${version} already exists, skip publish it`);
          await this.appendTaskLog(task, logs.join('\n'));
          logs = [];
          continue;
        }
      }

      const publishCmd = {
        scope,
        name,
        version,
        description,
        packageJson: item,
        readme,
        dist: {
          localFile,
        },
        isPrivate: false,
        publishTime,
        skipRefreshPackageManifests: true,
      };
      try {
        const pkgVersion = await this.packageManagerService.publish(publishCmd, users[0]);
        syncVersionCount++;
        logs.push(`[${isoNow()}] 🟢 [${index}] Synced version ${version} success, packageVersionId: ${pkgVersion.packageVersionId}, db id: ${pkgVersion.id}`);
      } catch (err: any) {
        if (err.name === 'ForbiddenError') {
          logs.push(`[${isoNow()}] 🐛 [${index}] Synced version ${version} already exists, skip publish error`);
        } else {
          err.taskId = task.taskId;
          this.logger.error(err);
          logs.push(`[${isoNow()}] ❌ [${index}] Synced version ${version} error, ${err}`);
        }
      }
      await this.appendTaskLog(task, logs.join('\n'));
      logs = [];
      await rm(localFile, { force: true });
      if (!skipDependencies) {
        const dependencies = item.dependencies || {};
        for (const dependencyName in dependencies) {
          dependenciesSet.add(dependencyName);
        }
      }
    }
    // try to read package entity again after first sync
    if (!pkg) {
      pkg = await this.packageRepository.findPackage(scope, name);
    }
    if (!pkg || !pkg.id) {
      // sync all versions fail in the first time
      logs.push(`[${isoNow()}] ❌ All versions sync fail, package not exists, log: ${logUrl}`);
      logs.push(`[${isoNow()}] ${failEnd}`);
      await this.finishTask(task, TaskState.Fail, logs.join('\n'));
      this.logger.info('[PackageSyncerService.executeTask:fail] taskId: %s, targetName: %s, package not exists',
        task.taskId, task.targetName);
      return;
    }

    // 2.1 save differentMetas
    for (const [ existsItem, diffMeta ] of differentMetas) {
      const pkgVersion = await this.packageRepository.findPackageVersion(pkg.packageId, existsItem.version);
      await this.packageManagerService.savePackageVersionManifest(pkgVersion!, diffMeta, diffMeta);
      syncVersionCount++;
      logs.push(`[${isoNow()}] 🟢 Synced version ${existsItem.version} success, different meta: ${JSON.stringify(diffMeta)}`);
    }

    if (syncVersionCount > 0) {
      await this.packageManagerService.refreshPackageManifestsToDists(pkg);
      logs.push(`[${isoNow()}] 🟢 Synced ${syncVersionCount} versions`);
    }

    // 3. update tags
    // "dist-tags": {
    //   "latest": "0.0.7"
    // },
    const changedTags: { tag: string, version?: string, action: string }[] = [];
    const distTags = data['dist-tags'] || {};
    for (const tag in distTags) {
      const version = distTags[tag];
      const changed = await this.packageManagerService.savePackageTag(pkg, tag, version);
      if (changed) changedTags.push({ action: 'change', tag, version });
    }
    // 3.1 find out remove tags
    const existsDistTags = existsData && existsData['dist-tags'] || {};
    for (const tag in existsDistTags) {
      if (!(tag in distTags)) {
        const changed = await this.packageManagerService.removePackageTag(pkg, tag);
        if (changed) changedTags.push({ action: 'remove', tag });
      }
    }
    if (changedTags.length > 0) {
      logs.push(`[${isoNow()}] 🟢 Synced ${changedTags.length} tags: ${JSON.stringify(changedTags)}`);
    }

    // 4. add package maintainers
    await this.packageManagerService.savePackageMaintainers(pkg, users);
    // 4.1 find out remove maintainers
    const removedMaintainers: unknown[] = [];
    const existsMaintainers = existsData && existsData.maintainers || [];
    for (const maintainer of existsMaintainers) {
      const npmUserName = maintainer.name.replace('npm:', '');
      if (!(npmUserName in maintainersMap)) {
        const user = await this.userRepository.findUserByName(maintainer.name);
        if (user) {
          await this.packageManagerService.removePackageMaintainer(pkg, user);
          removedMaintainers.push(maintainer);
        }
      }
    }
    if (removedMaintainers.length > 0) {
      logs.push(`[${isoNow()}] 🟢 Removed ${removedMaintainers.length} maintainers: ${JSON.stringify(removedMaintainers)}`);
    }

    // 5. add deps sync task
    for (const dependencyName of dependenciesSet) {
      const existsTask = await this.taskRepository.findTaskByTargetName(fullname, TaskType.SyncPackage, TaskState.Waiting);
      if (existsTask) {
        logs.push(`[${isoNow()}] 📖 Has dependency "${dependencyName}" sync task: ${existsTask.taskId}, db id: ${existsTask.id}`);
        continue;
      }
      const tips = `Sync cause by "${fullname}" dependencies, parent task: ${task.taskId}`;
      const dependencyTask = await this.createTask(dependencyName, {
        authorId: task.authorId,
        authorIp: task.authorIp,
        tips,
      });
      logs.push(`[${isoNow()}] 📦 Add dependency "${dependencyName}" sync task: ${dependencyTask.taskId}, db id: ${dependencyTask.id}`);
    }
    logs.push(`[${isoNow()}] 🟢 log: ${logUrl}`);
    logs.push(`[${isoNow()}] 🟢🟢🟢🟢🟢 ${url} 🟢🟢🟢🟢🟢`);
    await this.finishTask(task, TaskState.Success, logs.join('\n'));
    this.logger.info('[PackageSyncerService.executeTask:success] taskId: %s, targetName: %s',
      task.taskId, task.targetName);
  }

  private async appendTaskLog(task: Task, appendLog: string) {
    // console.log(appendLog);
    const nextPosition = await this.nfsAdapter.appendBytes(
      task.logPath,
      Buffer.from(appendLog + '\n'),
      task.logStorePosition,
      {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    );
    if (nextPosition) {
      task.logStorePosition = nextPosition;
    }
    task.updatedAt = new Date();
    await this.taskRepository.saveTask(task);
  }

  private async finishTask(task: Task, taskState: TaskState, appendLog: string) {
    const nextPosition = await this.nfsAdapter.appendBytes(
      task.logPath,
      Buffer.from(appendLog + '\n'),
      task.logStorePosition,
      {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    );
    if (nextPosition) {
      task.logStorePosition = nextPosition;
    }
    task.state = taskState;
    await this.taskRepository.saveTaskToHistory(task);
  }
}
