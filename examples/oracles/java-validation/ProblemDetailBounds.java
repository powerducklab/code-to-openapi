import jakarta.validation.Validation;
import org.springframework.samples.petclinic.rest.dto.ProblemDetailDto;
public class ProblemDetailBounds {
  public static void main(String[] args) {
    try (var factory = Validation.buildDefaultValidatorFactory()) {
      var validator = factory.getValidator();
      int[] values = {399, 400, 599, 600, 601};
      var output = new StringBuilder("{\"probes\":[");
      for (int i = 0; i < values.length; i++) {
        int value = values[i];
        boolean accepted = validator.validateValue(ProblemDetailDto.class, "status", value).isEmpty();
        if (accepted != (value >= 400 && value <= 600)) throw new AssertionError(value);
        if (i > 0) output.append(",");
        output.append("{\"status\":" + value + ",\"accepted\":" + accepted + "}");
      }
      System.out.println(output.append("]}"));
    }
  }
}
