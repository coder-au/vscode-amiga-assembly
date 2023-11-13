import { Position, DocumentColorProvider, TextDocument, ColorInformation, CancellationToken, ProviderResult, ColorPresentation, Color, Range } from 'vscode';

export class M86kColorProvider implements DocumentColorProvider {
    /**
     * Searches all the colors in document
     * @param document Document to search
     * @param token Cancellation token
     */
    public provideDocumentColors(
        document: TextDocument, token: CancellationToken):
        ProviderResult<ColorInformation[]> {
        let colors: ColorInformation[] = [];
        for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
            if (token.isCancellationRequested) {
                return null;
            }
            const line = document.lineAt(lineNumber);
            colors = colors.concat(this.searchColorsInLine(line.text, lineNumber));
        }
        return colors;
    }

    /**
     * Provide the representation of the color $ffffff.
     * @param color Color to represent
     * @param context Context
     * @param token Cancellation token
     */
    public provideColorPresentations(
        color: Color, context: { document: TextDocument, range: Range }):
        ProviderResult<ColorPresentation[]> {
        return [new ColorPresentation(this.formatColor(color, context.document.getText(context.range)))];
    }

    /**
     * Search for all the colors in a line.
     * 
     * @param line Text line
     * @param lineNumber Number of the line
     * @returns Array of color's information
     */
    public searchColorsInLine(line: string, lineNumber: number): ColorInformation[] {
        const colors: ColorInformation[] = [];
        const regexp = /(color[\d]{1,2}|(dff)?18[0-9a-f]|(dff)?19[0-9a-f]|(dff)?1a[0-9a-f]|(dff)?1b[0-9a-e])[\s]*[,][\s]*\$([\da-f]{3,4})/gi;
        let match;
        while ((match = regexp.exec(line))) {
            const value = match[match.length - 1];
            const idxDol = match[0].indexOf('$');
            const range = new Range(new Position(lineNumber, match.index + idxDol), new Position(lineNumber, match.index + idxDol + value.length + 1));
            let pos = 0;
            if (value.length > 3) {
                pos = 1;
            }
            const r = parseInt(value[pos++], 16) / 15;
            const g = parseInt(value[pos++], 16) / 15;
            const b = parseInt(value[pos], 16) / 15;
            const color: Color = new Color(r, g, b, 1);
            colors.push(new ColorInformation(range, color));
        }
        return colors;
    }

    /**
     * Formats a color to display
     * @param color Color to format
     * @param documentText Text from the document containing the color
     */
    public formatColor(color: Color, documentText: string): string {
        // search if there is 4 values
        let prefix = '$';
        if (documentText.length > 4) {
            prefix += documentText[1];
        }
        return prefix +
            this.formatColorComponent(color.red * 15) +
            this.formatColorComponent(color.green * 15) +
            this.formatColorComponent(color.blue * 15);
    }

    /**
     * Formats a number to print a color 'f' -> '0f'
     * @param value Number to format
     */
    private formatColorComponent(value: number): string {
        return Math.round(value).toString(16).substring(0, 2);
    }
}