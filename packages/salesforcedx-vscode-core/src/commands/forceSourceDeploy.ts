/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { CliCommandExecutor, Command, SfdxCommandBuilder } from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import { ContinueResponse } from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import * as path from 'path';
import { Observable } from 'rxjs/Observable';
import * as vscode from 'vscode';
import { channelService } from '../channels';
import { nls } from '../messages';
import { notificationService, ProgressNotification } from '../notifications';
import { taskViewService } from '../statuses';
import { SfdxCommandlet, SfdxCommandletExecutor, SfdxWorkspaceChecker } from './commands';
import { FileType, ManifestOrSourcePathGatherer, SelectedPath } from './forceSourceRetrieve';

interface Result {
  columnNumber: string;
  error: string;
  filePath: string;
  fullName: string;
  lineNumber: string;
  type: string;
}

interface ForceSourceDeployErrorResult {
  message: string;
  name: string;
  result: Result[];
  stack: string;
  status: number;
  warnings: any[];
}

// move this elsewhere?
vscode.workspace.onDidChangeTextDocument((e => {
  if (ForceSourceDeployExecutor._errorCollection.has(e.document.uri)) {
    ForceSourceDeployExecutor._errorCollection.delete(e.document.uri);
  }
}));

export class ForceSourceDeployExecutor extends SfdxCommandletExecutor<SelectedPath> {

  public static _errorCollection = vscode.languages.createDiagnosticCollection('deploy-errors');

  public build(data: SelectedPath): Command {
    const commandBuilder = new SfdxCommandBuilder()
      .withDescription(nls.localize('force_source_deploy_text'))
      .withArg('force:source:deploy')
      .withLogName('force_source_deploy')
      .withJson();
    if (data.type === FileType.Manifest) {
      commandBuilder.withFlag('--manifest', data.filePath);
    } else {
      commandBuilder.withFlag('--sourcepath', data.filePath);
    }
    return commandBuilder.build();
  }

  public execute(response: ContinueResponse<SelectedPath>): void {
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;

    const execution = new CliCommandExecutor(this.build(response.data), {
      cwd: vscode.workspace.rootPath
    }).execute(cancellationToken);

    let stdErr = '';
    execution.stderrSubject.subscribe(realData => {
      stdErr += realData.toString();
    });

    execution.processExitSubject.subscribe(async exitCode => {
      if (exitCode !== 0) {
        try {
          const compileErrs = this.getDeployResultData(stdErr);
          const fileErrors = this.groupErrorsByPath(compileErrs);
          Object.keys(fileErrors).forEach(filePath => {
            const uri = vscode.Uri.file(path.join(vscode.workspace.rootPath || '', filePath));
            const fileDiagnostics: vscode.Diagnostic[] = [];
            fileErrors[filePath].forEach(err => {
              fileDiagnostics.push(this.createDiagnosticFromResult(err));
            });
            ForceSourceDeployExecutor._errorCollection.set(uri, fileDiagnostics);
          });
        } catch (e) {
          // something else happened...?
          console.log(`Could not parse Compile Errors`);
        }
      }
    });

    notificationService.reportExecutionError(
      execution.command.toString(),
      (execution.stderrSubject as any) as Observable<Error | undefined>
    );
    this.logMetric(execution.command.logName);
    channelService.showChannelOutput();
    channelService.streamCommandOutput(execution);
    ProgressNotification.show(execution, cancellationTokenSource);
    taskViewService.addCommandExecution(execution, cancellationTokenSource);
  }

  private getDeployResultData(stdErr: string) {
    const stdErrLines = stdErr.split('\n');
    // hack to check for update msg in stderr... there must be a better way
    const json = stdErrLines.length > 1 && stdErrLines[0].indexOf('▸') > -1 ? stdErrLines[1] : stdErrLines[0]; // are line endings platform agnostic?
    return JSON.parse(json) as ForceSourceDeployErrorResult;
  }

  private groupErrorsByPath(deployResult: ForceSourceDeployErrorResult) {
    return deployResult.result.reduce<{ [key: string]: Result[] }>((results, err) => {
      if (results[err.filePath]) {
        results[err.filePath].push(err);
      } else {
        results[err.filePath] = [err];
      }
      return results;
    }, {});
  }

  private createDiagnosticFromResult(err: Result) {
    const ln = Number(err.lineNumber) - 1;
    const col = Number(err.columnNumber) - 1;
    const range = new vscode.Range(new vscode.Position(ln, col), new vscode.Position(ln, col));
    return new vscode.Diagnostic(range, err.error, vscode.DiagnosticSeverity.Error);
  }
}

const workspaceChecker = new SfdxWorkspaceChecker();

export async function forceSourceDeploy(explorerPath: any) {
  const commandlet = new SfdxCommandlet(
    workspaceChecker,
    new ManifestOrSourcePathGatherer(explorerPath),
    new ForceSourceDeployExecutor()
  );
  await commandlet.run();
}
