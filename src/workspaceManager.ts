import { ExtensionContext, InputBoxOptions, OpenDialogOptions, Uri, window } from "vscode";
import { FileProxy } from "./fsProxy";
import winston = require('winston');
import { ExtensionState } from "./extension";
import * as path from 'path';

export class WorkspaceManager {
    /**
     * Downloads the project.
     * @param context Extension context
     * @param version Version of te extension
     * @param destinationURI URI destination of the downloaded files
     */
    public async createExampleWorkspace(context: ExtensionContext, version: string, destinationURI?: Uri): Promise<Uri> {
        let destURI = destinationURI;
        let programName: string | undefined;
        if (!destURI) {
            [destURI, programName] = await this.showInputPanel();
        }
        winston.info(`Copying workspace example workspace to folder ${destURI}`);
        // Copy the example workspace
        const exampleProjectPath = Uri.file(path.join(ExtensionState.getCurrent().getResourcesPath(), "examples", "vscode-amiga-wks-example"));
        const exampleProjectFile = new FileProxy(exampleProjectPath);
        // copy files
        const destDir = new FileProxy(destURI);
        await exampleProjectFile.copy(destDir);
        const files = await destDir.listFiles();
        let workspaceFileFound: Uri | undefined;
        for (const f of files) {
            const baseName = f.getName();
            if (baseName.endsWith("code-workspace")) {
                workspaceFileFound = f.getUri();
            } else if (programName && baseName === "gencop.s") {
                // renaming the main file
                const destFile = f.getParent().getRelativeFile(`${programName}.s`)
                await f.rename(destFile);
            }
        }
        // Vscode config files
        if (programName) {
            const regexp = /gencop/g;
            const launchFile = destDir.getRelativeFile(".vscode/launch.json");
            await launchFile.replaceStringInFile(regexp, programName);
            const tasksFile = destDir.getRelativeFile(".vscode/tasks.json");
            await tasksFile.replaceStringInFile(regexp, programName);
            const startupFile = destDir.getRelativeFile("uae/dh0/s/startup-sequence");
            await startupFile.replaceStringInFile(regexp, programName);
        }
        if (workspaceFileFound) {
            return workspaceFileFound;
        } else {
            return destDir.getUri();
        }
    }

    /**
     * Shows an input panel
     * @return selected folder Uri
     */
    public async showInputPanel(): Promise<[Uri, string]> {
        winston.debug(`Opening Dialog`);
        const selectedFolders = await window.showOpenDialog(<OpenDialogOptions>{
            prompt: "Select the project folder",
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
        });
        if (selectedFolders && (selectedFolders.length > 0)) {
            const selectedFolder = selectedFolders[0];
            // select the program name
            let programName = await window.showInputBox(<InputBoxOptions>{ prompt: "Program name", title: "Set the program name", placeHolder: "program name" });
            if (programName && (programName.length > 0)) {
                if (programName.endsWith(".s")) {
                    programName = programName.replace(".s", "");
                }
                // check if there is files in the folder
                const fProxy = new FileProxy(selectedFolder);
                const subFiles = await fProxy.listFiles();
                if (subFiles.length > 0) {
                    const answer = await window.showWarningMessage("The folder is not empty. Do you really want to use it ?", "Yes", "Cancel");
                    if (answer === "Yes") {
                        winston.info(`Selected folder: ${selectedFolder} and program name: ${programName}`);
                        return [selectedFolder, programName];
                    }
                } else {
                    winston.info(`Selected folder: ${selectedFolder} and program name: ${programName}`);
                    return [selectedFolder, programName];
                }
            }
        }
        const message = "Example project creation canceled";
        window.showErrorMessage(message);
        throw new Error(message);
    }

}